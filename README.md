# Korvane Logistics Backend

Express and PostgreSQL API used by the Korvane React frontend. Shipment progress is calculated between saved start and end coordinates over the estimated transit duration; the browser refreshes tracking data every five seconds and interpolates marker movement between updates. Pausing freezes progress and extends the estimated arrival time by the full pause duration. This is schedule-based progress, not a GPS or carrier feed.

Shipment creation geocodes the sender and receiver addresses with the public OpenStreetMap Nominatim service. Those addresses are sent to Nominatim for lookup; requests are serialized with at least 1.1 seconds between lookups and successful results are cached in memory while the API process runs. Set `NOMINATIM_CONTACT` to a monitored contact detail (for example, an email address) so the service can identify and contact your deployment. Do not use the public geocoder for bulk or high-volume workloads.

The tracking page uses OpenStreetMap map tiles and displays shipment details, sender/receiver names and addresses, route coordinates, and the estimated position to anyone with the tracking number. Share tracking numbers only with intended recipients. Include the required OpenStreetMap attribution visible on the map.

## Setup

1. Create a PostgreSQL database and copy `.env.example` to `.env`.
2. Set `DATABASE_URL` to the new database connection string. Set `JWT_SECRET` and `SEED_SECRET` to separate, long, random values. Optionally set `NOMINATIM_CONTACT` to a monitored contact detail for geocoding requests. Keep `.env` private; it is ignored by Git.
3. From this directory, run `npm install`, then `npm run migrate` to create the tables.
4. Start the API with `npm run dev`. The React development server proxies `/api` requests to `http://localhost:5000`.
5. Create the initial admin using the `SEED_SECRET` set above:

   ```http
   POST http://localhost:5000/api/admin/seed
   Content-Type: application/json

   { "username": "your-admin-name", "password": "use-a-long-unique-password", "secret": "your-SEED_SECRET" }
   ```

   Use a password of at least 12 characters. Call the seed endpoint only from a trusted machine; anyone with the seed secret can create or reset an admin password.
6. Start the frontend from `frontend` with `npm run dev`, open `http://localhost:5173`, and use the **Admin portal** link in the footer to sign in.

## Deploy to Render

1. Connect your GitHub repository in the Render dashboard.
2. Set the backend service root to `backend`, **Build Command** to `npm install`, and **Start Command** to `npm start`.
3. Add `DATABASE_URL`, `JWT_SECRET`, `SEED_SECRET`, and `FRONTEND_ORIGIN` to the backend environment. Render provides `PORT`.
4. Run `npm run migrate` from the backend service context once against the new database.
5. Set `VITE_API_URL` to the backend origin when building the frontend for production. The local Vite proxy is only for development.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/admin/login | None | Login as admin |
| POST | /api/admin/seed | Seed secret | Create or reset admin account |
| PUT | /api/admin/credentials | Admin JWT | Change the signed-in admin username and/or password after confirming the current password |
| GET | /api/shipments | Admin JWT | List all shipments |
| POST | /api/shipments | Admin JWT | Create shipment |
| PUT | /api/shipments/:tracking_number | Admin JWT | Update status or pause/resume progress |
| DELETE | /api/shipments/:tracking_number | Admin JWT | Delete shipment |
| GET | /api/track/:tracking | None | Public tracking with shipment and sender/receiver details |
| POST | /api/contact | None | Submit contact form |
| GET | /api/contact | Admin JWT | List messages |
