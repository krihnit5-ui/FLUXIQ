# FluxIQ — 3D Urban Flood Intelligence

FluxIQ is a browser-based flood intelligence and nowcasting prototype for SIH 2026 (SIH26085). It combines live weather telemetry, NASA satellite context, GIS mapping, a 3D visualization layer, and explainable flood-pressure analysis.

## GitHub Pages deployment

This repository is a static frontend build. Keep `index.html` in the repository root.

1. Upload all files in this folder to the repository root.
2. Push to GitHub.
3. Open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select `main` and `/ (root)`.
6. Save and wait for the Pages URL.

No build command is required.

## Files

- `index.html` — application shell
- `app.js` — application logic and data integrations
- `styles.css` — UI and 3D-console styling
- `favicon.svg` — site icon

## Note

The current flood-pressure and drainage components are prototype/heuristic models. They are not an official flood warning or a calibrated hydraulic forecast. Production city deployment should use authoritative municipal drainage and validated historical-event data.
