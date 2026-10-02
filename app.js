/* FluxIQ — 3D live flood intelligence console
 * Live sources:
 *   - Open-Meteo: current + hourly weather-model telemetry for 36 India state/UT nodes
 *   - NASA GIBS: GPM IMERG + MODIS NRT map layers
 *   - Public India boundary GeoJSON for state drill-down
 * FluxIQ score: transparent derived heuristic with a simplified drainage-pressure proxy, NOT a hydraulic solver or calibrated flood probability.
 */

const NODES = [
  ["AP","Andhra Pradesh","Amaravati",16.51,80.52,"STATE","South"],["AR","Arunachal Pradesh","Itanagar",27.0844,93.6053,"STATE","Northeast"],["AS","Assam","Dispur",26.1433,91.7898,"STATE","Northeast"],["BR","Bihar","Patna",25.5941,85.1376,"STATE","East"],["CG","Chhattisgarh","Raipur",21.2514,81.6296,"STATE","Central"],["GA","Goa","Panaji",15.4909,73.8278,"STATE","West"],["GJ","Gujarat","Gandhinagar",23.2156,72.6369,"STATE","West"],["HR","Haryana","Chandigarh",30.7333,76.7794,"STATE","North"],["HP","Himachal Pradesh","Shimla",31.1048,77.1734,"STATE","North"],["JH","Jharkhand","Ranchi",23.3441,85.3096,"STATE","East"],["KA","Karnataka","Bengaluru",12.9716,77.5946,"STATE","South"],["KL","Kerala","Thiruvananthapuram",8.5241,76.9366,"STATE","South"],["MP","Madhya Pradesh","Bhopal",23.2599,77.4126,"STATE","Central"],["MH","Maharashtra","Mumbai",19.076,72.8777,"STATE","West"],["MN","Manipur","Imphal",24.817,93.9368,"STATE","Northeast"],["ML","Meghalaya","Shillong",25.5788,91.8933,"STATE","Northeast"],["MZ","Mizoram","Aizawl",23.7271,92.7176,"STATE","Northeast"],["NL","Nagaland","Kohima",25.6751,94.1086,"STATE","Northeast"],["OD","Odisha","Bhubaneswar",20.2961,85.8245,"STATE","East"],["PB","Punjab","Chandigarh",30.7333,76.7794,"STATE","North"],["RJ","Rajasthan","Jaipur",26.9124,75.7873,"STATE","North"],["SK","Sikkim","Gangtok",27.3389,88.6065,"STATE","Northeast"],["TN","Tamil Nadu","Chennai",13.0827,80.2707,"STATE","South"],["TS","Telangana","Hyderabad",17.385,78.4867,"STATE","South"],["TR","Tripura","Agartala",23.8315,91.2868,"STATE","Northeast"],["UP","Uttar Pradesh","Lucknow",26.8467,80.9462,"STATE","North"],["UK","Uttarakhand","Dehradun",30.3165,78.0322,"STATE","North"],["WB","West Bengal","Kolkata",22.5726,88.3639,"STATE","East"],
  ["AN","Andaman and Nicobar Islands","Port Blair",11.6234,92.7265,"UT","Islands"],["CH","Chandigarh","Chandigarh",30.7333,76.7794,"UT","North"],["DN","Dadra and Nagar Haveli and Daman and Diu","Daman",20.3974,72.8328,"UT","West"],["DL","Delhi","New Delhi",28.6139,77.209,"UT","North"],["JK","Jammu and Kashmir","Srinagar",34.0837,74.7973,"UT","North"],["LA","Ladakh","Leh",34.1526,77.5771,"UT","North"],["LD","Lakshadweep","Kavaratti",10.5669,72.642,"UT","Islands"],["PY","Puducherry","Puducherry",11.9416,79.8083,"UT","South"]
].map(([id,admin,capital,lat,lon,kind,region])=>({id,admin,capital,lat,lon,kind,region}));

const riskColor={LOW:"#54c998",MODERATE:"#d4bd68",HIGH:"#ff9a5f",CRITICAL:"#ff5d65"};
const liveById=new Map();
const probeById=new Map();
const markerById=new Map();
// Leaflet markers for the currently rendered local probe cells.
let probeMarkerByIndex=[];
const probeMarkerById=new Map();
let selected="DL", activeRisk="ALL", lastSync=null;
let scenarioMm=0;
let probeAbortCtrl=null;
let probeRequestSeq=0;
let map=null,boundaryLayer=null,selectedBoundary=null;
let nasaImergLayer=null,nasaTrueColorLayer=null,nasaAquaLayer=null;

const INDIA_BOUNDS=[[6.5,68],[35.8,97.5]];
const STATE_GEOJSON_URL="https://cdn.jsdelivr.net/gh/udit-001/india-maps-data@2884453/geojson/india.geojson";
const OPEN_METEO_URL="https://api.open-meteo.com/v1/forecast";
const NASA_WMS_BEST="https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi";
const NASA_WMS_NRT="https://gibs.earthdata.nasa.gov/wms/epsg3857/nrt/wms.cgi";
const PROBE_OFFSETS=[[0,0],[0.65,0.45],[-0.65,-0.45],[0.45,-0.75],[-0.45,0.75],[1,-0.35],[-1,0.35],[0.85,0.9],[-0.85,-0.9]];

function nodeById(id){return NODES.find(n=>n.id===id)}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
function sum(a){return (a||[]).reduce((x,y)=>x+(Number(y)||0),0)}
function roundedHalfHourUTC(latencyHours=4){const d=new Date(Date.now()-latencyHours*60*60*1000);d.setUTCMinutes(d.getUTCMinutes()-(d.getUTCMinutes()%30),0,0);return d.toISOString()}
function dateUTC(){return new Date().toISOString().slice(0,10)}
function fmtTime(value){try{return new Date(value).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}catch{return "—"}}
function fmtDateTime(value){try{return new Date(value).toLocaleString([], {day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}catch{return "—"}}

function deriveRisk(data){
  if(!data)return null;
  const times=data.hourly?.time||[], anchor=data.current?.time||null;
  let start=times.findIndex(t=>t===anchor);
  if(start<0&&anchor){const hhmm=String(anchor).slice(0,16);start=times.findIndex(t=>String(t).slice(0,16)===hhmm)}
  if(start<0)start=0;
  const rain3=sum((data.hourly?.precipitation||[]).slice(start,start+3));
  const rain24=sum((data.hourly?.precipitation||[]).slice(start,start+24));
  const prob6=Math.max(0,...(data.hourly?.precipitation_probability||[]).slice(start,start+6).map(Number));
  const rainPressure=clamp(rain3/60,0,1)*48;
  const dayPressure=clamp(rain24/180,0,1)*22;
  const soilPressure=clamp(Number(data.current?.soil_moisture_0_to_10cm||0)/.50,0,1)*18;
  const probPressure=clamp(prob6/100,0,1)*12;
  // Prototype drainage-pressure proxy: converts peak hourly rain to an
  // equivalent runoff load and compares it with a documented default
  // capacity. This is not a hydraulic solver; city drain/inlet data will
  // replace the default during calibration.
  const peak1h=Math.max(0,...(data.hourly?.precipitation||[]).slice(start,start+3).map(Number));
  const runoffCoefficient=0.70;
  const defaultDrainCapacityMmH=20;
  const runoffLoadMmH=peak1h*runoffCoefficient;
  const drainageExcessMmH=Math.max(0,runoffLoadMmH-defaultDrainCapacityMmH);
  const drainagePressure=clamp(drainageExcessMmH/30,0,1)*10;
  const score=Math.round(clamp(rainPressure+dayPressure+soilPressure+probPressure+drainagePressure,0,100));
  const level=score>=72?"CRITICAL":score>=52?"HIGH":score>=30?"MODERATE":"LOW";
  const required=[data.current?.temperature_2m,data.current?.relative_humidity_2m,data.current?.precipitation,data.current?.wind_speed_10m,data.current?.soil_moisture_0_to_10cm,data.hourly?.precipitation,data.hourly?.precipitation_probability];
  const integrity=Math.round(required.filter(v=>v!==undefined&&v!==null).length/required.length*100);
  return {score,level,rain1:Number(data.current?.precipitation||0),rain3:Number(rain3.toFixed(1)),rain24:Number(rain24.toFixed(1)),prob6:Math.round(prob6),soil:Number(data.current?.soil_moisture_0_to_10cm||0),temp:Number(data.current?.temperature_2m||0),humidity:Number(data.current?.relative_humidity_2m||0),wind:Number(data.current?.wind_speed_10m||0),peak1h:Number(peak1h.toFixed(1)),runoffLoadMmH:Number(runoffLoadMmH.toFixed(1)),defaultDrainCapacityMmH,drainageExcessMmH:Number(drainageExcessMmH.toFixed(1)),drainagePressure:Number(drainagePressure.toFixed(1)),integrity,fetchedAt:new Date().toISOString(),modelRun:data.current?.time||null,source:"Open-Meteo + FluxIQ drainage proxy"};
}
function queryStringFromNodes(nodes,extra={}){const p=new URLSearchParams();p.set("latitude",nodes.map(n=>n.lat).join(","));p.set("longitude",nodes.map(n=>n.lon).join(","));p.set("current","temperature_2m,relative_humidity_2m,precipitation,rain,showers,weather_code,wind_speed_10m,soil_moisture_0_to_10cm");p.set("hourly","precipitation,rain,showers,precipitation_probability");p.set("forecast_hours",String(extra.forecastHours||24));p.set("timezone","auto");return p.toString()}

function setDataBanner(text,state){const el=document.getElementById("liveStatus");if(el){el.textContent=text;el.className=`data-pill ${state}`}const led=document.getElementById("systemLed"),status=document.getElementById("systemStatus");if(status)status.textContent=state==="live"?"LIVE FEEDS ONLINE":state==="error"?"LIVE FEED DEGRADED":"SYNCING LIVE FEEDS";if(led){led.style.background=state==="error"?"#ff5d65":"#62e7e1";led.style.boxShadow=`0 0 0 5px ${state==="error"?"rgba(255,93,101,.1)":"rgba(98,231,225,.11)"},0 0 18px ${state==="error"?"rgba(255,93,101,.7)":"rgba(98,231,225,.8)"}`}}
function setSatelliteStatus(text,state="live"){const el=document.getElementById("satStatus");if(!el)return;el.textContent=text;el.className=`source-status ${state}`}

let fluxSocket=null;let socketReady=false;
function applyProPayload(payload){const rows=payload?.rows||[];rows.forEach(item=>{if(item?.node?.id)liveById.set(item.node.id,{node:item.node,...item,telemetry:item.telemetry});});lastSync=new Date(payload?.generatedAt||Date.now());setDataBanner(`LIVE PRO MODEL · ${rows.length}/${NODES.length} NODES · WS`,'live');const c=document.getElementById('coverageStat');if(c)c.textContent=`${rows.length}/${NODES.length}`;const s=document.getElementById('syncTime');if(s)s.textContent=fmtTime(lastSync);const peak=NODES.map(n=>({n,t:liveById.get(n.id)?.telemetry})).filter(x=>x.t).sort((a,b)=>b.t.score-a.t.score)[0];const pe=document.getElementById('peakPressure'),ps=document.getElementById('peakPressureSub');if(pe)pe.textContent=peak?`${peak.n.admin} · ${peak.t.score}`:'—';if(ps)ps.textContent=peak?`${peak.t.level} DEM + Manning pressure / 100`:'awaiting live telemetry';syncGlobeNodes();}
function connectFluxSocket(){if(!window.io)return;const base=String(window.FLUXIQ_API_URL||'').trim();try{fluxSocket=base?io(base,{transports:['websocket','polling']}):io({transports:['websocket','polling']});fluxSocket.on('connect',()=>{socketReady=true;setDataBanner('LIVE WEBSOCKET CONNECTED','live');});fluxSocket.on('telemetry_update',payload=>{socketReady=true;applyProPayload(payload);renderNetwork();renderWatch();updateIntel(nodeById(selected));updateMarkers();const n=nodeById(selected);if(n){fetchLocalProbes(n);loadDelhiPilotDrainage();}});fluxSocket.on('disconnect',()=>{socketReady=false;setDataBanner('LIVE SOCKET RECONNECTING…','loading');});fluxSocket.on('connect_error',()=>{socketReady=false;setDataBanner('SOCKET OFFLINE · FALLBACK MODE','loading');});fluxSocket.on('telemetry_error',err=>setDataBanner(`LIVE FEED DEGRADED · ${err?.message||'backend error'}`,'error'));}catch(e){console.warn('Socket init failed',e)}}
async function fetchLiveNationalFallback(){setDataBanner('SOCKET UNAVAILABLE · DIRECT WEATHER FALLBACK','loading');const res=await fetch(`${OPEN_METEO_URL}?${queryStringFromNodes(NODES)}`,{cache:'no-store'});if(!res.ok)throw new Error(`Open-Meteo HTTP ${res.status}`);const json=await res.json(),rows=Array.isArray(json)?json:[json];rows.forEach((row,i)=>{const node=NODES[i];if(node)liveById.set(node.id,{...row,telemetry:deriveRisk(row)});});lastSync=new Date();setDataBanner(`LIVE MODEL · ${rows.length}/${NODES.length} NODES · FALLBACK`,'live');document.getElementById('coverageStat').textContent=`${rows.length}/${NODES.length}`;document.getElementById('syncTime').textContent=fmtTime(lastSync);syncGlobeNodes();}
function fetchLiveNational(){if(socketReady)return Promise.resolve();return fetchLiveNationalFallback();}

async function fetchLocalProbes(node){
  if(probeAbortCtrl)probeAbortCtrl.abort();
  const requestId=++probeRequestSeq;
  probeAbortCtrl=new AbortController();
  const signal=probeAbortCtrl.signal;
  const probes=PROBE_OFFSETS.map(([dlat,dlon],i)=>({id:`${node.id}-P${i+1}`,label:`CELL ${String(i+1).padStart(2,"0")}`,lat:Number((node.lat+dlat).toFixed(4)),lon:Number((node.lon+dlon).toFixed(4)),sourceNode:node}));
  clearLocalProbes();
  document.getElementById("hotspotCount").textContent="LOADING…";
  document.getElementById("hotspotRows").innerHTML='<div class="empty-state">Querying 9 live local model cells…</div>';
  try{
    const res=await fetch(`${OPEN_METEO_URL}?${queryStringFromNodes(probes,{forecastHours:24})}`,{cache:"no-store",signal});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    const json=await res.json();
    if(requestId!==probeRequestSeq||selected!==node.id)return;
    (Array.isArray(json)?json:[json]).forEach((row,i)=>{const p=probes[i];if(p&&row)probeById.set(p.id,{...p,data:row,telemetry:deriveRisk(row)})});
    renderLocalProbes(node);
  }catch(err){
    if(err?.name==="AbortError")return;
    if(requestId!==probeRequestSeq||selected!==node.id)return;
    console.warn("Local probe feed unavailable",err);
    renderLocalProbes(node,true);
  }
}

function filteredNodes(){const q=document.getElementById("search").value.trim().toLowerCase();return NODES.filter(n=>{const t=liveById.get(n.id)?.telemetry;const matchesRisk=activeRisk==="ALL"||t?.level===activeRisk;const hay=[n.id,n.admin,n.capital,n.kind,n.region].join(" ").toLowerCase();return matchesRisk&&(!q||hay.includes(q))}).sort((a,b)=>(liveById.get(b.id)?.telemetry?.score||-1)-(liveById.get(a.id)?.telemetry?.score||-1))}
function renderNetwork(){const list=document.getElementById("networkList"),nodes=filteredNodes();document.getElementById("filteredCount").textContent=nodes.length;list.innerHTML=nodes.map(n=>{const t=liveById.get(n.id)?.telemetry,r=t?.level||"LOW";return `<button class="network-item ${n.id===selected?"active":""}" data-id="${n.id}" type="button"><span class="node-dot ${r.toLowerCase()}"></span><div class="node-copy"><div class="node-name">${escapeHtml(n.admin)}</div><div class="node-capital">${escapeHtml(n.capital)} · ${n.kind}</div></div><div class="node-risk ${r.toLowerCase()}">${t?.score??"—"}</div></button>`}).join("");list.querySelectorAll(".network-item").forEach(el=>el.addEventListener("click",()=>selectNode(el.dataset.id,true)))}
function renderWatch(){const rows=NODES.filter(n=>liveById.has(n.id)).sort((a,b)=>(liveById.get(b.id).telemetry.score-liveById.get(a.id).telemetry.score)).slice(0,5),count=rows.filter(n=>liveById.get(n.id).telemetry.score>=52).length;document.getElementById("watchCount").textContent=count;document.getElementById("watchlistRows").innerHTML=rows.map(n=>{const t=liveById.get(n.id).telemetry;return `<button class="watch-row" type="button" data-id="${n.id}"><div class="watch-left"><span class="node-dot ${t.level.toLowerCase()}"></span><strong>${escapeHtml(n.capital)} · ${escapeHtml(n.admin)}</strong></div><span class="watch-score ${t.level.toLowerCase()}">${t.score}</span></button>`}).join("");document.querySelectorAll(".watch-row").forEach(el=>el.addEventListener("click",()=>selectNode(el.dataset.id,true)));}
function cloneScenarioRecord(record,added){
  if(!record?.current)return null;
  const next={...record,current:{...record.current},hourly:{...record.hourly}};
  const amount=Math.max(0,Number(added)||0);
  next.current.precipitation=Number(next.current.precipitation||0)+amount;
  next.hourly.precipitation=[...(record.hourly?.precipitation||[])];
  if(next.hourly.precipitation.length){
    const anchor=next.hourly.time?.findIndex(t=>t===record.current.time) ?? 0;
    const start=anchor>=0?anchor:0;
    next.hourly.precipitation[start]=Number(next.hourly.precipitation[start]||0)+amount;
  }
  return next;
}
function scenarioTelemetry(recordOrTelemetry,mm=scenarioMm){
  if(!recordOrTelemetry)return null;
  const added=Math.max(0,Number(mm)||0);
  if(recordOrTelemetry.current){
    const baseline=deriveRisk(recordOrTelemetry);
    const projected=deriveRisk(cloneScenarioRecord(recordOrTelemetry,added));
    return projected?{...projected,scenarioMm:added,baseScore:baseline?.score??null,baseLevel:baseline?.level??"NO DATA"}:null;
  }
  // Derived telemetry alone is intentionally not projected. Scenario projections must
  // re-run the same pressure model against the underlying hourly record.
  return null;
}
function renderScenarioState(mm=scenarioMm){
  scenarioMm=Math.max(0,Number(mm)||0);
  const n=nodeById(selected), liveRecord=liveById.get(selected), base=liveRecord?.telemetry, projected=scenarioTelemetry(liveRecord,scenarioMm);
  const value=document.getElementById("scenarioMmValue"),score=document.getElementById("scenarioScore"),level=document.getElementById("scenarioLevel"),current=document.getElementById("scenarioCurrent");
  if(value)value.textContent=`+${scenarioMm} mm`;
  if(score)score.textContent=projected?`${projected.score}/100`:"—";
  if(level){level.textContent=projected?.level||"NO DATA";level.className=`scenario-level ${(projected?.level||"LOW").toLowerCase()}`}
  if(current)current.textContent=base?`Live baseline ${base.score}/100 · +${scenarioMm} mm synthetic stress`:"Live baseline unavailable";
  const rows=[...probeById.values()];
  rows.forEach(p=>{p.scenario=scenarioTelemetry(p.data,scenarioMm)});
  rows.sort((a,b)=>(b.scenario?.score??-1)-(a.scenario?.score??-1));
  document.querySelectorAll(".hotspot-row").forEach(row=>{
    const p=probeById.get(row.dataset.id); if(!p?.scenario)return;
    const s=row.querySelector(".hotspot-score"), meta=row.querySelector(".hotspot-meta");
    if(s){s.textContent=`${p.scenario.score}/100`;s.className=`hotspot-score ${p.scenario.level.toLowerCase()}`}
    if(meta){meta.innerHTML=`<span>${p.scenario.rain1.toFixed(1)} mm now</span><span>${p.scenario.rain3.toFixed(1)} mm / 3h</span><span>${p.scenario.prob6}% prob</span>`}
  });
  // Repaint visible local markers without inventing observations: these are projected drill states only.
  rows.slice(0,8).forEach((p,idx)=>{
    const m=probeMarkerById.get(p.id)||probeMarkerByIndex[idx], el=m?.getElement(); if(!el||!p.scenario)return;
    const dot=el.querySelector('.probe-marker'); if(dot)dot.className=`probe-marker ${p.scenario.level.toLowerCase()} scenario`;
  });
  if(n && base){
    const gMeta=document.getElementById("globeSelectedMeta");
    if(gMeta && scenarioMm>0)gMeta.textContent=`Live ${base.score}/100 · drill +${scenarioMm} mm → ${projected.score}/100 ${projected.level}`;
  }
}

function updateIntel(n){
  if(!n)return;
  const t=liveById.get(n.id)?.telemetry;
  document.getElementById("selectedTitle").textContent=`${n.admin} · ${n.capital}`;
  document.getElementById("ctaState").textContent=n.admin;
  document.getElementById("intelName").textContent=n.capital;
  document.getElementById("intelKind").textContent=`${n.kind} · ${n.region} · capital-centered live model node`;
  const chip=document.getElementById("intelRisk");
  chip.textContent=t?.level||"WAITING";
  chip.className=`risk-chip ${(t?.level||"LOW").toLowerCase()}`;
  document.getElementById("intelScore").textContent=t?.score==null?"—":t.score;
  document.getElementById("rainNow").textContent=t?`${t.rain1.toFixed(1)} mm`:"—";
  document.getElementById("rain3h").textContent=t?`${t.rain3.toFixed(1)} mm`:"—";
  document.getElementById("rain24h").textContent=t?`${t.rain24.toFixed(1)} mm`:"—";
  document.getElementById("soil").textContent=t?`${t.soil.toFixed(2)}`:"—";
  document.getElementById("prob").textContent=t?`${t.prob6}%`:"—";
  document.getElementById("wind").textContent=t?`${t.wind.toFixed(1)}`:"—";
  document.getElementById("intelSummary").textContent=!t?"Waiting for live telemetry…":t.level==="CRITICAL"?"Rainfall, persistence and near-surface moisture are combining into a high derived pressure reading.":t.level==="HIGH"?"Live pressure is elevated. Inspect the state focus grid and compare against official warnings.":t.level==="MODERATE"?"Live signals suggest a moderate pressure pattern. Watch the next 3–24 hours.":"Current live signals are below the dashboard's pressure thresholds; this is not a flood clearance.";
  const health=t?.integrity||0;
  document.getElementById("confidenceValue").textContent=health?`${health}% live fields`:"Waiting";
  document.getElementById("confidenceBar").style.width=`${health}%`;
  document.getElementById("actionBox").textContent=!t?"WAITING · No live telemetry returned for this node.":t.level==="CRITICAL"?"VERIFY NOW · Compare NASA IMERG, official warnings and local observations before operational action.":t.level==="HIGH"?"ELEVATED WATCH · Open the tactical map and inspect local live cells.":t.level==="MODERATE"?"WATCH · Keep satellite precipitation visible and monitor the next 3–24 hours.":"ROUTINE MONITORING · Continue watching live rainfall and official warnings.";
  document.getElementById("tacticalTitle").textContent=`${n.admin} · focused geospatial drill-down`;
  // Keep the globe overlay synchronized with the selected operational node.
  const gName=document.getElementById("globeSelectedName"),gMeta=document.getElementById("globeSelectedMeta");
  if(gName)gName.textContent=n.admin;
  if(gMeta)gMeta.textContent=t?`Live score: ${t.score}/100 · ${t.level}`:"Awaiting live telemetry";
  renderScenarioState(scenarioMm);
}

function popupForNode(n){const t=liveById.get(n.id)?.telemetry;return `<div class="popup-title">${escapeHtml(n.admin)}</div><div class="popup-sub">${escapeHtml(n.capital)} · ${n.kind}</div><div class="popup-row"><span>LIVE PRESSURE</span><span>${t?.score??"—"}/100 · ${t?.level??"WAITING"}</span></div><div class="popup-row"><span>1H PRECIP</span><span>${t?`${t.rain1.toFixed(1)} mm`:"—"}</span></div><div class="popup-row"><span>3H TOTAL</span><span>${t?`${t.rain3.toFixed(1)} mm`:"—"}</span></div>`}

function buildMap(){
  if(!window.L)return;
  map=L.map("map",{zoomControl:true,attributionControl:true,preferCanvas:true,worldCopyJump:false,minZoom:4,maxZoom:14}).fitBounds(INDIA_BOUNDS,{padding:[20,20]});
  // CARTO now requires a CARTO-issued API key for external basemap use.
  // Keep the deployed/static build key-free by using OSM as the primary base.
  // If a user supplies their own CARTO key at window.FLUXIQ_CARTO_API_KEY,
  // the dark CARTO layer is offered as an optional basemap.
  const osm=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap contributors"}).addTo(map);
  const cartoKey=String(window.FLUXIQ_CARTO_API_KEY||"").trim();
  const dark=cartoKey ? L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key=${encodeURIComponent(cartoKey)}`,{maxZoom:19,subdomains:"abcd",attribution:"© OpenStreetMap contributors © CARTO",crossOrigin:true}) : null;
  nasaTrueColorLayer=L.tileLayer.wms(NASA_WMS_NRT,{layers:"MODIS_Terra_CorrectedReflectance_TrueColor",format:"image/jpeg",transparent:true,version:"1.3.0",opacity:.55,time:dateUTC(),attribution:"NASA GIBS / MODIS Terra"});
  nasaAquaLayer=L.tileLayer.wms(NASA_WMS_NRT,{layers:"MODIS_Aqua_CorrectedReflectance_TrueColor",format:"image/jpeg",transparent:true,version:"1.3.0",opacity:.55,time:dateUTC(),attribution:"NASA GIBS / MODIS Aqua"});
  // NASA GIBS IMERG is an observational product and can temporarily lag the
  // clock or have gaps in its time dimension. Do NOT request a guessed future
  // timestamp: that creates the misleading "tile unavailable" banner seen on
  // static deployments. Let GIBS serve its current/default available slice and
  // only fall back to a dated request when the default slice fails.
  const imergBase={layers:"IMERG_Precipitation_Rate_30min",format:"image/png",transparent:true,version:"1.3.0",opacity:.72,attribution:"NASA GIBS / GPM IMERG"};
  nasaImergLayer=L.tileLayer.wms(NASA_WMS_BEST,imergBase).addTo(map);
  let imergFallbackTimer=null;
  nasaImergLayer.once("tileerror",()=>{
    clearTimeout(imergFallbackTimer);
    // If the default slice is unavailable, try the latest conservative
    // observation window rather than claiming that the current hour exists.
    const fallbackTime=roundedHalfHourUTC(72);
    const fallback=L.tileLayer.wms(NASA_WMS_BEST,{...imergBase,time:fallbackTime});
    fallback.once("load",()=>{
      if(map.hasLayer(nasaImergLayer))map.removeLayer(nasaImergLayer);
      nasaImergLayer=fallback;
      bindLayerToggle(nasaImergLayer,"toggleImerg");
      setSatelliteStatus(`NASA IMERG · latest available slice (${fmtDateTime(fallbackTime)})`,"live");
    });
    fallback.once("tileerror",()=>setSatelliteStatus("NASA IMERG temporarily unavailable · live weather model remains active","warning"));
    fallback.addTo(map);
  });
  imergFallbackTimer=setTimeout(()=>{
    if(nasaImergLayer && nasaImergLayer._tiles && Object.keys(nasaImergLayer._tiles).length)
      setSatelliteStatus("NASA IMERG · live GIBS slice", "live");
  },1800);
  [nasaTrueColorLayer,nasaAquaLayer].forEach((layer,i)=>layer.on("tileerror",()=>setSatelliteStatus(["NASA Terra tile unavailable for this UTC date window","NASA Aqua tile unavailable for this UTC date window"][i],"warning")));
  const baseLayers={"OpenStreetMap · primary":osm};
  if(dark) baseLayers["CARTO · DARK · keyed"]=dark;
  L.control.layers(baseLayers,{"NASA · GPM IMERG":nasaImergLayer,"NASA · MODIS Terra":nasaTrueColorLayer,"NASA · MODIS Aqua":nasaAquaLayer},{collapsed:false,position:"topright"}).addTo(map);
  buildNationalMarkers();
  loadBoundaryGeoJSON();
}

const DISPLAY_OFFSETS={HR:[-0.075,-0.12],PB:[0.075,0.12],CH:[0,0]};
function markerLatLon(n){const o=DISPLAY_OFFSETS[n.id];return o?[n.lat+o[0],n.lon+o[1]]:[n.lat,n.lon]}
function buildNationalMarkers(){markerById.forEach(m=>m.remove());markerById.clear();NODES.forEach(n=>{const icon=L.divIcon({className:"",html:`<div class="flux-marker low"><strong>${n.id}</strong><span class="marker-score">…</span></div>`,iconSize:[30,30],iconAnchor:[15,15]});const [mlat,mlon]=markerLatLon(n);const m=L.marker([mlat,mlon],{icon,title:`${n.admin} · ${n.capital}${DISPLAY_OFFSETS[n.id]?" · display-offset marker":""}`}).addTo(map);m.on("click",()=>selectNode(n.id,true));m.bindPopup(()=>popupForNode(n));markerById.set(n.id,m)})}

function syncLayerButton(layer,btnId){
  const btn=document.getElementById(btnId);
  if(!btn||!map||!layer)return;
  const sync=()=>{
    const active=map.hasLayer(layer);
    btn.classList.toggle("active",active);
    btn.setAttribute("aria-pressed",String(active));
  };
  const onLayerChange=e=>{if(e.layer===layer)sync()};
  map.on("layeradd layerremove overlayadd overlayremove",onLayerChange);
  sync();
}
function updateMarkers(){markerById.forEach((m,id)=>{const t=liveById.get(id)?.telemetry,el=m.getElement();if(!el)return;const risk=t?.level||"LOW";el.className=`flux-marker ${risk.toLowerCase()}${id===selected?" selected-marker":""}`;const s=el.querySelector(".marker-score");if(s)s.textContent=t?.score==null?"…":t.score})}
function normalizeName(s){return String(s||"").toLowerCase().replace(/&/g,"and").replace(/[^a-z0-9]+/g,"")}
function matchFeatureToNode(feature){const p=feature?.properties||{},raw=p.st_nm||p.ST_NM||p.name||p.NAME_1||p.shapeName||p.NAME||"",wanted=normalizeName(raw);return NODES.find(n=>normalizeName(n.admin)===wanted)||NODES.find(n=>wanted.includes(normalizeName(n.admin))||normalizeName(n.admin).includes(wanted))}
async function loadBoundaryGeoJSON(){
  const style={color:"#96cbd1",weight:.75,opacity:.52,fillColor:"#17353b",fillOpacity:.045};
  const makeLayer=(gj,source)=>{
    if(boundaryLayer)boundaryLayer.remove();
    selectedBoundary=null;
    boundaryLayer=L.geoJSON(gj,{style,onEachFeature:(feature,layer)=>layer.on({click:()=>{const n=matchFeatureToNode(feature);if(n)selectNode(n.id,true)}})}).addTo(map);
    boundaryLayer._fluxSource=source;
    highlightBoundary(nodeById(selected));
  };
  const sources=[
    STATE_GEOJSON_URL,
    "https://cdn.jsdelivr.net/gh/udit-001/india-maps-data@main/geojson/india.geojson"
  ];
  for(const url of sources){
    try{
      const res=await fetch(url,{cache:"force-cache"});
      if(!res.ok)throw new Error(`Boundary HTTP ${res.status}`);
      const gj=await res.json();
      if(gj?.type==="FeatureCollection" && Array.isArray(gj.features) && gj.features.length){
        makeLayer(gj,url.includes("@main")?"remote-live-reference":"remote-pinned-reference");
        setSatelliteStatus("NASA live · administrative boundaries loaded","live");
        return;
      }
    }catch(err){console.warn("Administrative boundary source unavailable",url,err)}
  }
  // Do not substitute synthetic polygons. A missing boundary is safer and more truthful
  // than rendering a generated envelope as an administrative boundary.
  if(boundaryLayer){boundaryLayer.remove();boundaryLayer=null}
  selectedBoundary=null;
  setSatelliteStatus("NASA live · boundary source unavailable","warning");
}
function highlightBoundary(n){if(selectedBoundary){selectedBoundary.setStyle({color:"#96cbd1",weight:.75,opacity:.52,fillColor:"#17353b",fillOpacity:.045});selectedBoundary=null}if(!boundaryLayer)return;boundaryLayer.eachLayer(layer=>{const candidate=matchFeatureToNode(layer.feature);if(candidate?.id===n.id){selectedBoundary=layer;const c=riskColor[liveById.get(n.id)?.telemetry?.level||"LOW"];layer.setStyle({color:c,weight:2.6,opacity:1,fillColor:c,fillOpacity:layer.feature?.properties?.fallback?0.06:0.12,dashArray:layer.feature?.properties?.fallback?"6 6":null});layer.bringToFront()}})}
function mapStateDetail(n){document.getElementById("tacticalMode").textContent=`STATE DRILL · ${n.admin.toUpperCase()}`;document.getElementById("focusTitle").textContent=`${n.admin.toUpperCase()} · LIVE FOCUS`;document.getElementById("focusSubtitle").textContent=`${n.capital} · capital-centered live local focus grid · NASA layers available`;document.getElementById("mapModeChip").textContent="STATE FOCUS";document.getElementById("backIndia").hidden=false;document.getElementById("stateFocusBanner")?.classList.add("visible");document.getElementById("stateFocusText")?.replaceChildren(document.createTextNode(`${n.admin.toUpperCase()} · LIVE FOCUS`));document.getElementById("stateFocusSubtext")?.replaceChildren(document.createTextNode(`${n.capital} · live local focus grid`));highlightBoundary(n);const bounds=selectedBoundary?.getBounds();if(bounds?.isValid())map.fitBounds(bounds.pad(.16),{animate:true});else map.setView([n.lat,n.lon],8,{animate:true});document.getElementById("tacticalSection").scrollIntoView({behavior:"smooth",block:"start"})}
function backToIndia(){if(probeAbortCtrl)probeAbortCtrl.abort();probeRequestSeq++;document.getElementById("tacticalMode").textContent="NATIONAL LIVE VIEW";document.getElementById("mapModeChip").textContent="NATIONAL";document.getElementById("focusTitle").textContent="INDIA · NATIONAL";document.getElementById("focusSubtitle").textContent="Choose any state or UT to open a live local focus grid.";document.getElementById("backIndia").hidden=true;document.getElementById("stateFocusBanner")?.classList.remove("visible");if(selectedBoundary){selectedBoundary.setStyle({color:"#96cbd1",weight:.75,opacity:.52,fillColor:"#17353b",fillOpacity:.045});selectedBoundary=null}if(map)map.fitBounds(INDIA_BOUNDS,{padding:[20,20],animate:true});clearLocalProbes()}
function clearLocalProbes(){probeById.clear();probeMarkerByIndex.forEach(m=>m?.remove());probeMarkerByIndex=[];probeMarkerById.clear();document.getElementById("hotspotCount").textContent="—";document.getElementById("hotspotRows").innerHTML='<div class="empty-state">Select a state or UT to load live local probe cells.</div>'}

const DELHI_DRAINAGE_REFERENCE_FALLBACK=[
  {name:'Ali Drain',lengthKm:2.78,catchmentHa:3893,designDischargeCusecs:2500,designDischargeM3s:70.79},
  {name:'Adar Drain',lengthKm:2.61,catchmentHa:951.05,designDischargeCusecs:235,designDischargeM3s:6.65},
  {name:'Mider Drain',lengthKm:1.4,catchmentHa:48.58,designDischargeCusecs:60,designDischargeM3s:1.7},
  {name:'Sarita Vihar Drain',lengthKm:1.3,catchmentHa:1294.99,designDischargeCusecs:2070,designDischargeM3s:58.64}
];

async function loadDelhiPilotDrainage(){
  const grid=document.getElementById('pilotDrainGrid'); if(!grid)return;
  if(selected!=='DL'){grid.innerHTML='<div class="pilot-loading">Select Delhi to load the Delhi pilot drainage reference.</div>';return;}
  try{
    const r=await fetch(`${window.FLUXIQ_API_URL||''}/api/pilot/delhi/drainage`,{cache:'no-store'});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const d=await r.json();
    const status=d.geometryAvailable?'GIS CONNECTED':'REFERENCE ONLY';
    const statusClass=d.geometryAvailable?'gis-live':'reference';
    grid.innerHTML=`<div class="pilot-gis-status ${statusClass}"><strong>${status}</strong><span>${d.geometryAvailable?`${d.geojson.features.length} GeoJSON features loaded`:'No authenticated machine-readable geometry configured yet'}</span></div>`+(d.assets||[]).map(x=>`<div class="pilot-drain-item"><strong>${escapeHtml(x.name)}</strong><span>${x.lengthKm.toFixed(2)} km · ${x.catchmentHa.toFixed(0)} ha</span><b>${x.designDischargeCusecs.toFixed(0)} cusecs · ${x.designDischargeM3S.toFixed(2)} m³/s</b><span class="pilot-source">${escapeHtml(x.authority)}</span></div>`).join('')+`<div class="pilot-source-links"><a href="${d.sourceMap}" target="_blank" rel="noopener">Official Delhi drainage map</a><a href="${d.masterPlan}" target="_blank" rel="noopener">Delhi Drainage Master Plan</a></div>`;
  }catch(e){grid.innerHTML='<div class="pilot-loading">Pilot drainage reference unavailable from backend.</div>';}
}
function renderLocalProbes(node,unavailable=false){probeMarkerByIndex.forEach(m=>m?.remove());probeMarkerByIndex=[];probeMarkerById.clear();if(unavailable){document.getElementById("hotspotRows").innerHTML='<div class="empty-state">Live local cells unavailable right now. Keep NASA IMERG active and retry.</div>';document.getElementById("hotspotCount").textContent="NO DATA";return}const rows=[...probeById.values()].sort((a,b)=>(b.telemetry?.score||-1)-(a.telemetry?.score||-1));const critical=rows.filter(r=>r.telemetry?.level==="CRITICAL").length;document.getElementById("hotspotCount").textContent=`${rows.length} LIVE · ${critical} CRITICAL`;document.getElementById("hotspotRows").innerHTML=rows.slice(0,8).map(p=>{const t=p.telemetry;return `<button class="hotspot-row" type="button" data-id="${p.id}"><div class="hotspot-top"><span class="hotspot-id">${p.label}</span><span class="hotspot-score ${t.level.toLowerCase()}">${t.score}/100</span></div><div class="hotspot-meta"><span>${t.rain1.toFixed(1)} mm now</span><span>${t.rain3.toFixed(1)} mm / 3h</span><span>${t.prob6}% prob</span></div></button>`}).join("");rows.slice(0,8).forEach((p,idx)=>{const icon=L.divIcon({className:"",html:`<div class="probe-marker ${p.telemetry?.level?.toLowerCase()||'low'}"></div>`,iconSize:[18,18],iconAnchor:[9,9]});const m=L.marker([p.lat,p.lon],{icon}).addTo(map);m.bindPopup(`<div class="popup-title">${p.label} · ${escapeHtml(node.admin)}</div><div class="popup-sub">Live model probe · capital-centered live local focus grid</div><div class="popup-row"><span>PRESSURE</span><span>${p.telemetry.score}/100</span></div><div class="popup-row"><span>3H RAIN</span><span>${p.telemetry.rain3.toFixed(1)} mm</span></div>`);probeMarkerByIndex[idx]=m;probeMarkerById.set(p.id,m)});document.querySelectorAll(".hotspot-row").forEach(el=>el.addEventListener("click",()=>{const p=probeById.get(el.dataset.id);if(!p)return;map.setView([p.lat,p.lon],10,{animate:true});const idx=rows.slice(0,8).findIndex(x=>x.id===p.id);if(idx>=0)probeMarkerByIndex[idx]?.openPopup()}))}

// ---------- 3D command globe (self-contained Canvas 3D; no external 3D runtime) ----------
let globeCanvas=null, globeCtx=null, globeRAF=0, globeCleanup=null, globeInitialized=false, globeAutoRotate=true, globeDownAt=0, globeDownX=0, globeDownY=0, globeStartX=0, globeStartY=0, globeDrag=false, globeZoom=1, hoverNode=null;
let globeRotation={x:-0.22,y:0.34};
const globeScreenNodes=new Map();
const GLOBE_R=1.16;
const globeStars=Array.from({length:260},(_,i)=>({
  x:Math.sin(i*12.9898)*.5+.5,
  y:Math.sin(i*78.233)*.5+.5,
  size:0.45+(i%4)*0.25,
  alpha:0.16+(i%7)*0.045
}));
const globeRain=Array.from({length:110},(_,i)=>({
  lat:-2+((i*37)%95),
  lon:62+((i*71)%78),
  len:5+(i%7)*1.8,
  speed:.00045+(i%5)*.00009,
  phase:(i*0.173)%1
}));

function v3(x,y,z){return {x,y,z}}
function dot(a,b){return a.x*b.x+a.y*b.y+a.z*b.z}
function normalize3(p){const m=Math.hypot(p.x,p.y,p.z)||1;return v3(p.x/m,p.y/m,p.z/m)}
function add3(a,b){return v3(a.x+b.x,a.y+b.y,a.z+b.z)}
function mul3(a,k){return v3(a.x*k,a.y*k,a.z*k)}
function latLon3(lat,lon,r=GLOBE_R){
  const la=lat*Math.PI/180, lo=lon*Math.PI/180;
  return v3(r*Math.cos(la)*Math.cos(lo),r*Math.sin(la),r*Math.cos(la)*Math.sin(lo));
}
function rotateGlobePoint(p){
  const cx=Math.cos(globeRotation.x),sx=Math.sin(globeRotation.x),cy=Math.cos(globeRotation.y),sy=Math.sin(globeRotation.y);
  const y1=p.y*cx-p.z*sx, z1=p.y*sx+p.z*cx;
  const x2=p.x*cy+z1*sy, z2=-p.x*sy+z1*cy;
  return v3(x2,y1,z2);
}
function projectGlobePoint(p,w,h){
  const camera=3.15, scale=Math.min(w,h)*0.40*globeZoom;
  const perspective=scale/(camera-p.z*0.82);
  return {x:w/2+p.x*perspective,y:h/2-p.y*perspective,z:p.z,scale:perspective};
}
function globeRisk(level){return riskColor[level||'LOW']||riskColor.LOW}
function roundedRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}

function globePath(ctx, points){
  let open=false;
  points.forEach(q=>{
    const p=projectGlobePoint(rotateGlobePoint(q),globeCanvas.width/globeDpr,globeCanvas.height/globeDpr);
    if(!open){ctx.moveTo(p.x,p.y);open=true}else ctx.lineTo(p.x,p.y);
  });
}
let globeDpr=Math.max(1,Math.min(window.devicePixelRatio||1,2));

function drawGlobeGrid(ctx,w,h){
  const lines=[];
  for(let lat=-75;lat<=75;lat+=15){
    const pts=[];for(let lon=-180;lon<=180;lon+=4)pts.push(latLon3(lat,lon,GLOBE_R*1.002));lines.push(pts)
  }
  for(let lon=-180;lon<180;lon+=15){
    const pts=[];for(let lat=-88;lat<=88;lat+=4)pts.push(latLon3(lat,lon,GLOBE_R*1.002));lines.push(pts)
  }
  lines.forEach(pts=>{
    let drawing=false;
    ctx.beginPath();
    pts.forEach(q=>{
      const r=rotateGlobePoint(q),front=r.z>-.08,p=projectGlobePoint(r,w,h);
      if(front&&!drawing){ctx.moveTo(p.x,p.y);drawing=true}
      else if(front)ctx.lineTo(p.x,p.y);
      else drawing=false;
    });
    ctx.strokeStyle='rgba(98,231,225,.11)';ctx.lineWidth=.7;ctx.stroke();
  });
}

function drawGlobeConnections(ctx,w,h){
  const selectedNode=nodeById(selected);if(!selectedNode)return;
  const neighbours=NODES.filter(n=>n.id!==selectedNode.id)
    .sort((a,b)=>(Math.abs(a.lat-selectedNode.lat)+Math.abs(a.lon-selectedNode.lon))-(Math.abs(b.lat-selectedNode.lat)+Math.abs(b.lon-selectedNode.lon)))
    .slice(0,9);
  neighbours.forEach(n=>{
    const a=normalize3(latLon3(selectedNode.lat,selectedNode.lon,1));
    const b=normalize3(latLon3(n.lat,n.lon,1));
    const mid=normalize3(add3(a,b));
    const lift=1.34+Math.min(.16,Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)*.05);
    const pts=[];for(let i=0;i<=28;i++){const t=i/28,u=1-t;pts.push(mul3(normalize3(add3(add3(mul3(a,u*u),mul3(mid,2*u*t)),mul3(b,t*t))),GLOBE_R*lift));}
    ctx.beginPath();let started=false;
    pts.forEach(q=>{const r=rotateGlobePoint(q);const p=projectGlobePoint(r,w,h);if(r.z>0&&(!started)){ctx.moveTo(p.x,p.y);started=true}else if(r.z>0){ctx.lineTo(p.x,p.y)}else if(started){ctx.stroke();ctx.beginPath();started=false}});if(started)ctx.stroke();
    ctx.strokeStyle='rgba(98,231,225,.16)';ctx.lineWidth=1;
  });
}

function drawOrbitRing(ctx,w,h,radius,alpha,dash=[]) {
  const cx=w/2,cy=h/2,R=Math.min(w,h)*radius*globeZoom;
  ctx.save();ctx.translate(cx,cy);ctx.rotate(globeRotation.y*.32);ctx.scale(1,.36+Math.abs(Math.sin(globeRotation.x))*.08);
  ctx.setLineDash(dash);ctx.beginPath();ctx.arc(0,0,R,0,Math.PI*2);ctx.strokeStyle=`rgba(98,231,225,${alpha})`;ctx.lineWidth=1;ctx.stroke();ctx.restore();
}
function drawGlobeHud(ctx,w,h,R,cx,cy){
  const t=performance.now();
  // orbital rings create depth around the command globe
  drawOrbitRing(ctx,w,h,.43,.13,[18,10]);drawOrbitRing(ctx,w,h,.49,.075,[3,14]);
  // rotating radar sweep
  const a=(t*.00022)% (Math.PI*2);ctx.save();ctx.translate(cx,cy);ctx.rotate(a);
  const sweep=ctx.createLinearGradient(0,0,R,0);sweep.addColorStop(0,'rgba(98,231,225,0)');sweep.addColorStop(.72,'rgba(98,231,225,.02)');sweep.addColorStop(1,'rgba(98,231,225,.28)');
  ctx.fillStyle=sweep;ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,R,-.055,.055);ctx.closePath();ctx.fill();ctx.restore();
  // scan ticks
  ctx.strokeStyle='rgba(148,231,232,.18)';ctx.lineWidth=1;
  for(let i=0;i<36;i++){const q=i*Math.PI*2/36;const rr=R*1.075;const x1=cx+Math.cos(q)*rr,y1=cy+Math.sin(q)*rr,x2=cx+Math.cos(q)*(rr+((i%3===0)?7:3)),y2=cy+Math.sin(q)*(rr+((i%3===0)?7:3));ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke()}
}

function drawGlobe(){
  if(!globeCanvas||!globeCtx)return;
  const rect=globeCanvas.getBoundingClientRect(),w=Math.max(320,rect.width),h=Math.max(420,rect.height),dpr=Math.max(1,Math.min(window.devicePixelRatio||1,2));
  if(globeCanvas.width!==Math.round(w*dpr)||globeCanvas.height!==Math.round(h*dpr)){globeCanvas.width=Math.round(w*dpr);globeCanvas.height=Math.round(h*dpr);globeCtx.setTransform(dpr,0,0,dpr,0,0)}
  globeDpr=dpr;
  globeCtx.clearRect(0,0,w,h);
  const ctx=globeCtx;
  ctx.fillStyle='rgba(2,9,14,.02)';ctx.fillRect(0,0,w,h);

  // Deep-space stars — deterministic and lightweight.
  globeStars.forEach((s,i)=>{const x=(s.x*w+w*.03*(i%3-1))%w,y=(s.y*h+h*.16)%h;ctx.beginPath();ctx.arc(x,y,s.size,0,Math.PI*2);ctx.fillStyle=`rgba(155,220,224,${s.alpha})`;ctx.fill()});

  const R=Math.min(w,h)*.38*globeZoom,cx=w/2,cy=h/2;
  const glow=ctx.createRadialGradient(cx-R*.18,cy-R*.24,R*.05,cx,cy,R*1.25);glow.addColorStop(0,'rgba(70,207,214,.24)');glow.addColorStop(.42,'rgba(24,108,125,.12)');glow.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(cx,cy,R*1.35,0,Math.PI*2);ctx.fill();

  // Sphere body.
  const sphere=ctx.createRadialGradient(cx-R*.26,cy-R*.28,R*.04,cx,cy,R);sphere.addColorStop(0,'#183844');sphere.addColorStop(.56,'#0b222c');sphere.addColorStop(.88,'#06121b');sphere.addColorStop(1,'#02080e');ctx.fillStyle=sphere;ctx.beginPath();ctx.arc(cx,cy,R,0,Math.PI*2);ctx.fill();
  ctx.save();ctx.beginPath();ctx.arc(cx,cy,R,0,Math.PI*2);ctx.clip();drawGlobeGrid(ctx,w,h);drawGlobeConnections(ctx,w,h);ctx.restore();

  // Rim / atmosphere.
  ctx.beginPath();ctx.arc(cx,cy,R,0,Math.PI*2);ctx.strokeStyle='rgba(104,232,228,.42)';ctx.lineWidth=1.25;ctx.stroke();
  ctx.beginPath();ctx.arc(cx,cy,R*1.055,0,Math.PI*2);ctx.strokeStyle='rgba(94,209,222,.10)';ctx.lineWidth=8;ctx.stroke();
  drawGlobeHud(ctx,w,h,R,cx,cy);

  // Volumetric rain field — only rendered on the front hemisphere.
  const now=performance.now();
  globeRain.forEach((drop,i)=>{
    const q=latLon3(drop.lat,drop.lon,GLOBE_R*1.008);
    const r=rotateGlobePoint(q);if(r.z<.05)return;
    const p=projectGlobePoint(r,w,h);const phase=(drop.phase+now*drop.speed)%1;
    ctx.strokeStyle=`rgba(98,231,225,${.06+.16*(1-phase)})`;ctx.lineWidth=.65;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x+2,p.y+drop.len*(.45+phase));ctx.stroke();
  });

  globeScreenNodes.clear();
  const projected=NODES.map(node=>{
    const r=rotateGlobePoint(latLon3(node.lat,node.lon));
    const p=projectGlobePoint(r,w,h);return {node,r,p,telemetry:liveById.get(node.id)?.telemetry};
  }).sort((a,b)=>a.r.z-b.r.z);
  projected.forEach(item=>{
    const {node,r,p,telemetry}=item;if(p.x<-40||p.x>w+40||p.y<-40||p.y>h+40)return;
    const visible=r.z>-0.02, level=telemetry?.level||'LOW',col=globeRisk(level),sel=node.id===selected;
    const alpha=visible?(sel?1:.88):.12;
    const base=sel?14:9;
    if(visible){
      // 3D risk column extrudes from the globe surface to give each node depth.
      const height=5+(telemetry?.score||0)*.075;
      const nx=p.x + (r.x>0?height*.34:-height*.18), ny=p.y-height;
      ctx.strokeStyle=hexToRgba(col,.28);ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(nx,ny);ctx.stroke();
      ctx.beginPath();ctx.arc(p.x,p.y,base+Math.sin(performance.now()*.003+node.lat)*2.2,0,Math.PI*2);ctx.strokeStyle=hexToRgba(col,sel?.75:.32);ctx.lineWidth=sel?1.4:1;ctx.stroke()}
    ctx.beginPath();ctx.arc(p.x,p.y,visible?(sel?5.2:3.5):2.1,0,Math.PI*2);ctx.fillStyle=hexToRgba(col,alpha);ctx.shadowBlur=visible?(sel?18:10):0;ctx.shadowColor=col;ctx.fill();ctx.shadowBlur=0;
    if(sel&&visible){ctx.beginPath();ctx.arc(p.x,p.y,10+Math.sin(performance.now()*.004)*2,0,Math.PI*2);ctx.strokeStyle=hexToRgba(col,.26);ctx.lineWidth=2;ctx.stroke();
      const label=`${node.admin.toUpperCase()} · ${telemetry?.score??'…'}`;ctx.font='700 11px Inter, system-ui, sans-serif';const tw=ctx.measureText(label).width;const bx=p.x+13,by=p.y-18;roundedRect(ctx,bx,by,tw+16,26,8);ctx.fillStyle='rgba(3,10,15,.88)';ctx.fill();ctx.strokeStyle=hexToRgba(col,.35);ctx.stroke();ctx.fillStyle='#eaf8f7';ctx.fillText(label,bx+8,by+17)}
    globeScreenNodes.set(node.id,{x:p.x,y:p.y,z:r.z,hit:visible});
  });

  // Orientation reticle.
  ctx.strokeStyle='rgba(98,231,225,.07)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(w*.18,h*.5);ctx.lineTo(w*.82,h*.5);ctx.stroke();ctx.beginPath();ctx.moveTo(w*.5,h*.16);ctx.lineTo(w*.5,h*.84);ctx.stroke();
}
function hexToRgba(hex,a){const h=hex.replace('#','');const n=parseInt(h.length===3?h.split('').map(c=>c+c).join(''):h,16);return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`}

function syncGlobeConnections(){drawGlobe()}
function syncGlobeNodes(){drawGlobe()}
function pickGlobeNode(clientX,clientY){if(!globeCanvas)return null;const r=globeCanvas.getBoundingClientRect(),x=clientX-r.left,y=clientY-r.top;let best=null,dist=Infinity;globeScreenNodes.forEach((p,id)=>{if(!p.hit)return;const d=Math.hypot(p.x-x,p.y-y);if(d<Math.max(14,20/globeZoom)&&d<dist){dist=d;best=id}});return best}
function resizeGlobe(){drawGlobe()}
function setupGlobe(){
  if(globeCleanup)globeCleanup();
  globeCanvas=document.getElementById('globeCanvas');if(!globeCanvas)return;globeCtx=globeCanvas.getContext('2d',{alpha:true,desynchronized:true});
  if(!globeCtx){globeCanvas.setAttribute('aria-label','2D fallback command globe unavailable; use the tactical map below.');return}
  globeCanvas.style.cursor='grab';
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  globeAutoRotate=!reduced;
  const onPointerDown=e=>{
    globeDownAt=performance.now();globeDownX=e.clientX;globeDownY=e.clientY;globeStartX=e.clientX;globeStartY=e.clientY;
    if(e.pointerType==='touch'){globeDrag=false;globeCanvas.style.cursor='pointer';return}
    globeDrag=true;globeCanvas.setPointerCapture?.(e.pointerId);globeCanvas.style.cursor='grabbing';document.getElementById('globeStage')?.classList.add('dragging')
  };
  const onPointerMove=e=>{if(globeDrag){globeRotation.y+=(e.clientX-globeDownX)*.0042;globeRotation.x=clamp(globeRotation.x+(e.clientY-globeDownY)*.0022,-.72,.72);globeDownX=e.clientX;globeDownY=e.clientY;globeAutoRotate=false;document.getElementById('globeAuto')?.classList.remove('active');drawGlobe()}else if(e.pointerType!=='touch'){hoverNode=pickGlobeNode(e.clientX,e.clientY);globeCanvas.style.cursor=hoverNode?'pointer':'grab'}};
  const onPointerUp=e=>{const moved=Math.hypot(e.clientX-globeStartX,e.clientY-globeStartY);const wasTouch=e.pointerType==='touch';globeDrag=false;globeCanvas.style.cursor='grab';document.getElementById('globeStage')?.classList.remove('dragging');if((wasTouch||performance.now()-globeDownAt<450)&&moved<10){const id=pickGlobeNode(e.clientX,e.clientY);if(id)selectNode(id,true)}try{globeCanvas.releasePointerCapture?.(e.pointerId)}catch{}};
  const onPointerCancel=()=>{globeDrag=false;globeCanvas.style.cursor='grab';document.getElementById('globeStage')?.classList.remove('dragging')};
  const onWheel=e=>{e.preventDefault();globeZoom=clamp(globeZoom+(e.deltaY>0?-0.06:0.06),.82,1.28);drawGlobe()};
  const reset=()=>{globeRotation={x:-.22,y:.34};globeZoom=1;drawGlobe()};
  const toggleAuto=e=>{globeAutoRotate=!globeAutoRotate;e.currentTarget.classList.toggle('active',globeAutoRotate)};
  globeCanvas.addEventListener('pointerdown',onPointerDown);globeCanvas.addEventListener('pointermove',onPointerMove);globeCanvas.addEventListener('pointerup',onPointerUp);globeCanvas.addEventListener('pointercancel',onPointerCancel);globeCanvas.addEventListener('wheel',onWheel,{passive:false});
  const resetBtn=document.getElementById('globeReset'),autoBtn=document.getElementById('globeAuto');resetBtn?.addEventListener('click',reset);autoBtn?.addEventListener('click',toggleAuto);
  const onResize=()=>resizeGlobe();window.addEventListener('resize',onResize,{passive:true});
  const hint=document.getElementById('globeHint');if(hint&&window.matchMedia?.('(max-width: 720px)').matches)hint.textContent='Tap a node to focus · swipe page to scroll';
  drawGlobe();
  const tick=()=>{if(globeAutoRotate&&!globeDrag&&!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){globeRotation.y+=.0011;drawGlobe()}globeRAF=requestAnimationFrame(tick)};globeRAF=requestAnimationFrame(tick);
  globeInitialized=true;
  globeCleanup=()=>{cancelAnimationFrame(globeRAF);globeRAF=0;window.removeEventListener('resize',onResize);globeCanvas?.removeEventListener('pointerdown',onPointerDown);globeCanvas?.removeEventListener('pointermove',onPointerMove);globeCanvas?.removeEventListener('pointerup',onPointerUp);globeCanvas?.removeEventListener('pointercancel',onPointerCancel);globeCanvas?.removeEventListener('wheel',onWheel);resetBtn?.removeEventListener('click',reset);autoBtn?.removeEventListener('click',toggleAuto);globeDrag=false;globeCanvas?.classList.remove('dragging')};
}
function selectNode(id,fly=true){
  const n=nodeById(id);if(!n)return;
  if(selected!==id&&probeAbortCtrl)probeAbortCtrl.abort();
  if(selected!==id)probeRequestSeq++;
  selected=id;scenarioMm=0;
  updateIntel(n);renderNetwork();renderWatch();updateMarkers();syncGlobeNodes();updateCityTwin();
  if(fly){mapStateDetail(n);fetchLocalProbes(n)}else{clearLocalProbes()}
  loadDelhiPilotDrainage();
}

async function refreshLive(){try{if(socketReady){setDataBanner("LIVE WEBSOCKET · STREAM ACTIVE","live");return;}await fetchLiveNationalFallback();renderNetwork();renderWatch();updateIntel(nodeById(selected));updateMarkers();const n=nodeById(selected);if(n)fetchLocalProbes(n)}catch(err){console.error(err);setDataBanner(`LIVE FEED ERROR · ${err.message}`,"error")}}


// ---------- 3D city digital twin (schematic prototype renderer) ----------
let twinCanvas=null,twinCtx=null,twinRAF=0,twinAutoRotate=true,twinDrag=false,twinYaw=.55,twinPitch=.72,twinZoom=1,twinDownX=0,twinDownY=0,twinTimeStep=0;
function twinData(){return liveById.get(selected)?.telemetry||null}
function twinProject(x,y,z,w,h){
  const cy=Math.cos(twinYaw),sy=Math.sin(twinYaw),cp=Math.cos(twinPitch),sp=Math.sin(twinPitch);
  const rx=x*cy-z*sy, rz=x*sy+z*cy, ry=y*cp-rz*sp, depth=y*sp+rz*cp;
  const scale=Math.min(w,h)*.30*twinZoom;
  return {x:w*.5+rx*scale,y:h*.53-ry*scale,depth};
}
function twinLine(ctx,pts,alpha=1,lw=1){ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.strokeStyle=`rgba(98,231,225,${alpha})`;ctx.lineWidth=lw;ctx.stroke()}
function twinDraw(){
  if(!twinCanvas||!twinCtx)return;
  const r=twinCanvas.getBoundingClientRect(),w=Math.max(420,r.width),h=Math.max(420,r.height),dpr=Math.min(devicePixelRatio||1,2);
  if(twinCanvas.width!==Math.round(w*dpr)||twinCanvas.height!==Math.round(h*dpr)){twinCanvas.width=Math.round(w*dpr);twinCanvas.height=Math.round(h*dpr)}
  const ctx=twinCtx;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  const t=twinData(),pressure=t?.score||0,depth=Math.max(0,Math.min(2.2,(pressure/100)*1.5+twinTimeStep*.08));
  const ground=[];
  for(let gy=-5;gy<=5;gy++)for(let gx=-7;gx<=7;gx++){
    const ridge=.16*Math.sin(gx*.65)*Math.cos(gy*.55)+.08*Math.sin((gx+gy)*.8);
    ground.push({gx,gy,z:ridge});
  }
  // Ground plane / terrain mesh.
  for(let gy=-5;gy<5;gy++)for(let gx=-7;gx<7;gx++){
    const a=ground.find(p=>p.gx===gx&&p.gy===gy),b=ground.find(p=>p.gx===gx+1&&p.gy===gy),c=ground.find(p=>p.gx===gx+1&&p.gy===gy+1),d=ground.find(p=>p.gx===gx&&p.gy===gy+1);
    const pa=twinProject(a.gx/1.8,a.z,a.gy/1.8,w,h),pb=twinProject(b.gx/1.8,b.z,b.gy/1.8,w,h),pc=twinProject(c.gx/1.8,c.z,c.gy/1.8,w,h),pd=twinProject(d.gx/1.8,d.z,d.gy/1.8,w,h);
    ctx.beginPath();ctx.moveTo(pa.x,pa.y);ctx.lineTo(pb.x,pb.y);ctx.lineTo(pc.x,pc.y);ctx.lineTo(pd.x,pd.y);ctx.closePath();ctx.fillStyle=`rgba(12,38,43,${.35+(1-(a.gy+5)/10)*.08})`;ctx.fill();ctx.strokeStyle='rgba(98,231,225,.045)';ctx.stroke();
  }
  // Roads and drainage network are deliberately schematic until municipal GIS is connected.
  const roadColor='rgba(145,171,177,.35)',drainColor='rgba(98,231,225,.75)';
  for(let i=-3;i<=3;i++){
    const a=twinProject(-3.9,i*.42,.12,w,h),b=twinProject(3.9,i*.42,.12,w,h);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=roadColor;ctx.lineWidth=i===0?3:1.2;ctx.stroke();
  }
  for(let i=-3;i<=3;i++){
    const a=twinProject(i*.75,-2.8,.13,w,h),b=twinProject(i*.75,2.8,.13,w,h);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle='rgba(145,171,177,.22)';ctx.lineWidth=1;ctx.stroke();
  }
  const drains=[[-3.6,-2.2,3.5,1.8],[-3.3,1.7,2.9,-1.4],[-1.8,-2.6,-.2,2.3],[1.4,-2.4,3.4,1.1]];
  drains.forEach((d,i)=>{const a=twinProject(d[0],.2,d[1],w,h),b=twinProject(d[2],.2,d[3],w,h);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=drainColor;ctx.lineWidth=i===0?2.5:1.4;ctx.shadowBlur=10;ctx.shadowColor='#62e7e1';ctx.stroke();ctx.shadowBlur=0});
  // Stylised city blocks with extruded height.
  const blocks=[];for(let gy=-2;gy<=2;gy++)for(let gx=-4;gx<=4;gx++){
    if((gx+gy)%3===0)continue; const ht=.12+.08*Math.abs(Math.sin(gx*2.1+gy));blocks.push({x:gx*.75,y:gy*.72,h:ht});
  }
  blocks.sort((a,b)=>a.y-b.y).forEach(b=>{
    const base=twinProject(b.x,b.h*.35,b.y,w,h),top=twinProject(b.x,b.h+.35,b.y,w,h),w1=.18*twinZoom;
    ctx.fillStyle='rgba(95,126,134,.28)';ctx.strokeStyle='rgba(155,206,211,.12)';
    ctx.beginPath();ctx.rect(top.x-w1,top.y-w1*.45,w1*2,w1*.9);ctx.fill();ctx.stroke();
    ctx.beginPath();ctx.moveTo(top.x-w1,top.y-w1*.45);ctx.lineTo(base.x-w1,base.y-w1*.45);ctx.lineTo(base.x+w1,base.y-w1*.45);ctx.lineTo(top.x+w1,top.y-w1*.45);ctx.strokeStyle='rgba(98,231,225,.08)';ctx.stroke();
  });
  // Flood surface expands from low corridor as the time slider advances.
  const waterAlpha=.10+Math.min(.32,depth*.12),spread=.55+depth*.8;
  ctx.beginPath();
  for(let i=0;i<=28;i++){const x=-4.2+i*(8.4/28),z=-spread+Math.sin(i*.7)*.18;const p=twinProject(x,.09-depth*.04,z,w,h);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)}
  for(let i=28;i>=0;i--){const x=-4.2+i*(8.4/28),z=spread+Math.cos(i*.6)*.18;const p=twinProject(x,.09-depth*.04,z,w,h);ctx.lineTo(p.x,p.y)}ctx.closePath();ctx.fillStyle=`rgba(50,145,255,${waterAlpha})`;ctx.fill();ctx.strokeStyle=`rgba(70,180,255,${Math.min(.75,.25+depth*.15)})`;ctx.lineWidth=1.2;ctx.stroke();
  // Hotspots from current pressure/probe count.
  const hotCount=Math.max(2,Math.min(8,Math.round((pressure/100)*7)+2));
  for(let i=0;i<hotCount;i++){const x=-3.2+(i%4)*2.1+(twinTimeStep*.04),z=-1.7+Math.floor(i/4)*2.0;const p=twinProject(x,.16+depth*.03,z,w,h);const rad=5+pressure/18;ctx.beginPath();ctx.arc(p.x,p.y,rad,0,Math.PI*2);ctx.fillStyle=`rgba(255,93,101,${.16+.04*twinTimeStep})`;ctx.fill();ctx.beginPath();ctx.arc(p.x,p.y,3.5,0,Math.PI*2);ctx.fillStyle='#ff5d65';ctx.shadowBlur=14;ctx.shadowColor='#ff5d65';ctx.fill();ctx.shadowBlur=0}
  // Rain particles.
  for(let i=0;i<70;i++){const x=((i*37)%100)/100*8-4,z=((i*61)%100)/100*6-3;const y=1.8+((i*17+twinTimeStep*8)%20)/10;const p=twinProject(x,y,z,w,h);ctx.strokeStyle=`rgba(98,231,225,${.08+(i%5)*.025})`;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x-2,p.y+9);ctx.stroke()}
  // Center label.
  ctx.fillStyle='rgba(210,249,248,.7)';ctx.font='700 10px ui-monospace,monospace';ctx.fillText('DEM-INFORMED TERRAIN + MANNING HYDRAULIC PROXY',w*.5-145,h-28);
  const tlabel=['NOW','+30 MIN','+1 H','+2 H','+3 H','+4 H','+6 H'][twinTimeStep]||'NOW';
  document.getElementById('twinTimeLabel').textContent=tlabel;document.getElementById('twinPressure').textContent=t?`${Math.min(100,Math.round(pressure+twinTimeStep*pressure*.06))}/100`:'—';document.getElementById('twinRunoff').textContent=t?`${(t.runoffLoadMmH||0).toFixed(1)} mm/h`:'—';document.getElementById('twinDrainExcess').textContent=t?`${(Math.max(0,(t.drainageExcessMmH||0)+twinTimeStep*.7)).toFixed(1)} mm/h`:'—';document.getElementById('twinHotspots').textContent=t?String(hotCount):'—';document.getElementById('twinDepth').textContent=`${depth.toFixed(2)} m`;
}
function setupCityTwin(){
  twinCanvas=document.getElementById('cityTwinCanvas');if(!twinCanvas)return;twinCtx=twinCanvas.getContext('2d',{alpha:true});
  const down=e=>{twinDrag=true;twinDownX=e.clientX;twinDownY=e.clientY;twinCanvas.setPointerCapture?.(e.pointerId);twinCanvas.classList.add('dragging');twinAutoRotate=false;document.getElementById('twinRotate')?.classList.remove('active')};
  const move=e=>{if(!twinDrag)return;twinYaw+=(e.clientX-twinDownX)*.008;twinPitch=clamp(twinPitch+(e.clientY-twinDownY)*.006,.45,1.1);twinDownX=e.clientX;twinDownY=e.clientY;twinDraw()};
  const up=e=>{twinDrag=false;twinCanvas.classList.remove('dragging');try{twinCanvas.releasePointerCapture?.(e.pointerId)}catch{}};
  const wheel=e=>{e.preventDefault();twinZoom=clamp(twinZoom+(e.deltaY>0?-0.06:.06),.75,1.35);twinDraw()};
  twinCanvas.addEventListener('pointerdown',down);twinCanvas.addEventListener('pointermove',move);twinCanvas.addEventListener('pointerup',up);twinCanvas.addEventListener('pointercancel',up);twinCanvas.addEventListener('wheel',wheel,{passive:false});
  document.getElementById('twinReset')?.addEventListener('click',()=>{twinYaw=.55;twinPitch=.72;twinZoom=1;twinTimeStep=0;const sl=document.getElementById('twinTime');if(sl)sl.value='0';twinDraw()});
  document.getElementById('twinRotate')?.addEventListener('click',e=>{twinAutoRotate=!twinAutoRotate;e.currentTarget.classList.toggle('active',twinAutoRotate)});
  document.getElementById('twinTime')?.addEventListener('input',e=>{twinTimeStep=Number(e.target.value)||0;twinDraw()});
  document.getElementById('openTwinBtn')?.addEventListener('click',()=>{document.getElementById('cityTwinSection')?.scrollIntoView({behavior:'smooth',block:'start'});setTimeout(twinDraw,120)});
  const resize=()=>twinDraw();window.addEventListener('resize',resize);twinRAF=requestAnimationFrame(function tick(){if(twinAutoRotate&&!twinDrag&&!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){twinYaw+=.0025;twinDraw()}twinRAF=requestAnimationFrame(tick)});
  twinDraw();
}
function updateCityTwin(){
  const n=nodeById(selected),t=twinData();if(!n)return;
  document.getElementById('twinTitle').textContent=`${n.admin} · flood propagation lab`;document.getElementById('twinNodeName').textContent=n.admin.toUpperCase();document.getElementById('twinNodeMeta').textContent=t?`${t.level} · ${t.score}/100 derived pressure`:'Live pressure field unavailable';twinDraw();
}

function setup(){
  if(window.__fluxIQSetupDone)return;window.__fluxIQSetupDone=true;
  setupGlobe();setupCityTwin();buildMap();renderNetwork();renderWatch();updateIntel(nodeById(selected));updateCityTwin();
  const search=document.getElementById("search");
  search.addEventListener("input",renderNetwork);
  search.addEventListener("keydown",e=>{
    if(e.key!=="Enter")return;
    e.preventDefault();
    const first=filteredNodes()[0];
    if(first){selectNode(first.id,true);setTimeout(()=>document.querySelector(`#networkList .network-item[data-id="${first.id}"]`)?.focus(),0);}
  });
  document.querySelectorAll(".filter").forEach(btn=>btn.addEventListener("click",()=>{activeRisk=btn.dataset.risk;document.querySelectorAll(".filter").forEach(b=>b.classList.toggle("active",b===btn));renderNetwork()}));
  document.getElementById("refreshBtn").addEventListener("click",refreshLive);
  document.getElementById("overviewBtn").addEventListener("click",backToIndia);
  document.getElementById("tacticalBtn").addEventListener("click",()=>document.getElementById("tacticalSection").scrollIntoView({behavior:"smooth",block:"start"}));
  document.getElementById("focusSelectedBtn").addEventListener("click",()=>{const n=nodeById(selected);if(n){mapStateDetail(n);fetchLocalProbes(n)}});
  document.getElementById("backIndia").addEventListener("click",backToIndia);
  const bindLayerToggle=(layer,btnId)=>{const btn=document.getElementById(btnId);if(!btn)return;btn.addEventListener("click",()=>{if(!map||!layer)return;if(map.hasLayer(layer))map.removeLayer(layer);else layer.addTo(map);});syncLayerButton(layer,btnId)};
  bindLayerToggle(nasaImergLayer,"toggleImerg");
  bindLayerToggle(nasaTrueColorLayer,"toggleTerra");
  bindLayerToggle(nasaAquaLayer,"toggleAqua");
  const dlg=document.getElementById("briefDialog");
  document.getElementById("briefBtn").addEventListener("click",()=>{document.getElementById("scenarioControl")?.setAttribute("hidden","");scenarioMm=0;const n=nodeById(selected),t=liveById.get(selected)?.telemetry;document.getElementById("briefTitle").textContent=`${n.admin} · live flood brief`;document.getElementById("briefText").textContent=t?`${n.admin} has a derived flood-pressure score of ${t.score}/100 (${t.level}). Current precipitation is ${t.rain1.toFixed(1)} mm, the next 3-hour total is ${t.rain3.toFixed(1)} mm, the next 24-hour total is ${t.rain24.toFixed(1)} mm, and 0–10 cm soil moisture is ${t.soil.toFixed(2)} m³/m³. This brief uses live model telemetry; compare with NASA precipitation, official warnings and local observations before operational action.`:`Live telemetry is unavailable for ${n.admin} right now. Keep the satellite layer active and retry.`;document.getElementById("briefConfidence").textContent=t?`${t.integrity}% fields live`:"NO DATA";document.getElementById("briefNode").textContent=n.id;dlg.showModal()});
  document.getElementById("scenarioBtn").addEventListener("click",()=>{
    document.getElementById("scenarioControl")?.removeAttribute("hidden");
    const n=nodeById(selected),t=liveById.get(selected)?.telemetry;
    scenarioMm=40;
    const slider=document.getElementById("scenarioMm");if(slider){slider.step="5";slider.value="40";}
    document.getElementById("briefTitle").textContent=`Cloudburst tabletop · ${n.admin}`;
    document.getElementById("briefText").textContent=`Synthetic stress test only. Adjust added precipitation to stress the current live 3-hour context. The projection changes the derived pressure score for the drill and never changes the observed NASA or live-model values.`;
    document.getElementById("briefConfidence").textContent="DRILL";
    document.getElementById("briefNode").textContent=n.id;
    renderScenarioState(40);
    dlg.showModal();
  });
  document.getElementById("scenarioMm")?.addEventListener("input",e=>{renderScenarioState(Number(e.target.value));});
  const resetBrief=()=>{scenarioMm=0;document.getElementById("scenarioControl")?.setAttribute("hidden","");};
  dlg.addEventListener("close",resetBrief);
  document.getElementById("closeBrief").addEventListener("click",()=>{resetBrief();dlg.close()});
  connectFluxSocket();
  refreshLive();
}
window.addEventListener("load",setup);
