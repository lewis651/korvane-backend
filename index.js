import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import http from 'http';
import { Server } from 'socket.io';

dotenv.config();

const { Pool } = pkg;
const app = express();
const port = process.env.PORT || 5000;
const adminLoginAttempts = new Map();
const geocodeCache = new Map();
let geocodeQueue = Promise.resolve();
let nextGeocodeAt = 0;
const shipmentStatuses = new Set([
  'Processing',
  'In Transit',
  'At Customs',
  'Out for Delivery',
  'Delayed',
  'Delivered',
]);
const packageTypes = new Set([
  'FCL Container',
  'LCL Container',
  'Air Cargo',
  'Pallet',
  'Crate',
  'Parcel',
  'Bulk Cargo',
]);

async function geocodeAddress(address) {
  const cacheKey = address.trim().toLowerCase();
  const cached = geocodeCache.get(cacheKey);
  if (cached) return cached;

  const request = geocodeQueue.then(async () => {
    const remainingDelay = nextGeocodeAt - Date.now();
    if (remainingDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, remainingDelay));
    }
    nextGeocodeAt = Date.now() + 1100;

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', address);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    const response = await fetch(url, {
      headers: {
        'User-Agent': `KorvaneLogistics/1.0${process.env.NOMINATIM_CONTACT ? ` (${process.env.NOMINATIM_CONTACT})` : ''}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(`Address geocoding service returned HTTP ${response.status}`);
    }
    const results = await response.json();
    if (!Array.isArray(results)) {
      throw new Error('Address geocoding service returned an invalid response');
    }
    if (results.length === 0) return null;

    const lat = Number(results[0].lat);
    const lng = Number(results[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new Error('Address geocoding service returned invalid coordinates');
    }
    const coordinates = { lat, lng };
    geocodeCache.set(cacheKey, coordinates);
    return coordinates;
  });
  geocodeQueue = request.then(() => undefined, () => undefined);
  return request;
}

// ─── Environment Verification ────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL is missing in environment variables.');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is missing in environment variables.');
  process.exit(1);
}
if (!process.env.SEED_SECRET) {
  console.error('❌ FATAL: SEED_SECRET is missing in environment variables.');
  process.exit(1);
}

// ─── Dynamic Allowed Origins (Fixes CORS "Failed to fetch") ───────────────────
const allowedOrigins = [
  (process.env.FRONTEND_ORIGIN || '').replace(/\/+$/, '').trim(),
  'http://localhost:5173',
  'http://localhost:3000'
].filter(Boolean);

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // Allow non-browser requests (Postman, curl, server-to-server)
  return allowedOrigins.includes(origin);
};

// ─── HTTP & Socket.IO Setup ──────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Socket.IO CORS blocked for origin: ${origin}`));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ─── DB Pool ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

pool.on('connect', () => console.log('✅ Connected to PostgreSQL'));
pool.on('error', (err) => { console.error('DB error:', err.message || err); });

// ─── Express Middleware ────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy violation for origin: ${origin}`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '64kb' }));

const limitAdminLoginAttempts = (req, res, next) => {
  const now = Date.now();
  for (const [key, attempt] of adminLoginAttempts) {
    if (attempt.resetAt <= now) adminLoginAttempts.delete(key);
  }
  const key = req.ip;
  const attempt = adminLoginAttempts.get(key);
  if (attempt && attempt.count >= 10) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  adminLoginAttempts.set(key, {
    count: (attempt?.count || 0) + 1,
    resetAt: attempt?.resetAt || now + 15 * 60 * 1000,
  });
  next();
};

// ─── Auth Middleware ───────────────────────────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
};

// ─── Health Route ──────────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'OK', message: 'Korvane API is running', database: 'connected' });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({ status: 'ERROR', message: 'Database connection failed' });
  }
});

// ─── Admin Auth ────────────────────────────────────────────────────────────────
// Seed admin (run once or to reset admin credentials)
app.post('/api/admin/seed', async (req, res) => {
  try {
    const { username, password, secret } = req.body;
    if (!secret || secret !== process.env.SEED_SECRET) {
      return res.status(403).json({ error: 'Forbidden: Invalid seed secret' });
    }
    if (typeof username !== 'string' || typeof password !== 'string' ||
        !username.trim() || password.length < 12 || username.trim().length > 100) {
      return res.status(400).json({ error: 'Username (up to 100 characters) and a password of at least 12 characters are required' });
    }

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO admins (username, password_hash) 
       VALUES ($1, $2) 
       ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
      [username.trim(), hash]
    );

    res.json({ message: 'Admin account seeded successfully' });
  } catch (err) {
    console.error('Admin seed error:', err);
    res.status(500).json({ error: 'Server error during seeding' });
  }
});

// Admin Login
app.post('/api/admin/login', limitAdminLoginAttempts, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' ||
        !username.trim() || !password || username.trim().length > 100 || password.length > 200) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const cleanUsername = username.trim();
    const result = await pool.query(
      'SELECT * FROM admins WHERE LOWER(username) = LOWER($1)',
      [cleanUsername]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = result.rows[0];

    // Safe check: handle unseeded or non-string password hashes in DB
    if (!admin.password_hash || typeof admin.password_hash !== 'string') {
      console.error('An admin account has an invalid password_hash in the database.');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: admin.id, username: admin.username },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    adminLoginAttempts.delete(req.ip);
    res.json({ token, admin: { id: admin.id, username: admin.username } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

app.put('/api/admin/credentials', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, username, newPassword } = req.body;
    if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 200) {
      return res.status(400).json({ error: 'Enter your current password to confirm this change' });
    }

    if (username !== undefined &&
        (typeof username !== 'string' || !username.trim() || username.trim().length > 100)) {
      return res.status(400).json({ error: 'Username must be non-empty and no longer than 100 characters' });
    }
    if (newPassword !== undefined && newPassword !== '' &&
        (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 200)) {
      return res.status(400).json({ error: 'New password must be between 12 and 200 characters' });
    }

    const adminId = Number(req.admin.id);
    if (!Number.isInteger(adminId) || adminId <= 0) {
      return res.status(401).json({ error: 'Invalid or expired authentication token' });
    }

    const adminResult = await pool.query(
      'SELECT id, username, password_hash FROM admins WHERE id = $1',
      [adminId]
    );
    const admin = adminResult.rows[0];
    if (!admin || typeof admin.password_hash !== 'string' ||
        !(await bcrypt.compare(currentPassword, admin.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const cleanUsername = username === undefined ? admin.username : username.trim();
    const changingPassword = typeof newPassword === 'string' && newPassword.length > 0;
    if (cleanUsername.toLowerCase() === admin.username.toLowerCase() && !changingPassword) {
      return res.status(400).json({ error: 'Enter a new username or password to update your login details' });
    }

    const usernameResult = await pool.query(
      'SELECT id FROM admins WHERE LOWER(username) = LOWER($1) AND id <> $2',
      [cleanUsername, adminId]
    );
    if (usernameResult.rows.length > 0) {
      return res.status(409).json({ error: 'That username is already in use' });
    }

    const passwordHash = changingPassword ? await bcrypt.hash(newPassword, 12) : admin.password_hash;
    const updateResult = await pool.query(
      'UPDATE admins SET username = $1, password_hash = $2 WHERE id = $3 RETURNING id, username',
      [cleanUsername, passwordHash, adminId]
    );
    const updatedAdmin = updateResult.rows[0];
    const token = jwt.sign(
      { id: updatedAdmin.id, username: updatedAdmin.username },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      message: 'Admin login details updated successfully',
      token,
      admin: { id: updatedAdmin.id, username: updatedAdmin.username },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That username is already in use' });
    }
    console.error('Admin credential update error:', err);
    res.status(500).json({ error: 'Server error updating admin login details' });
  }
});

// ─── Shipments (Admin) ────────────────────────────────────────────────────────
// Create shipment
app.post('/api/shipments', authMiddleware, async (req, res) => {
  try {
    const {
      tracking_number, sender_name, sender_address,
      receiver_name, receiver_address, start_location, end_location,
      total_hours,
      weight, description, package_type, status
    } = req.body;

    const durationHours = Number(total_hours);
    const cleanTrackingNumber = typeof tracking_number === 'string' ? tracking_number.trim().toUpperCase() : '';
    if (!/^[A-Z0-9][A-Z0-9-]{2,49}$/.test(cleanTrackingNumber) ||
        typeof sender_name !== 'string' || !sender_name.trim() || sender_name.trim().length > 255 ||
        typeof sender_address !== 'string' || !sender_address.trim() || sender_address.trim().length > 1000 ||
        typeof receiver_name !== 'string' || !receiver_name.trim() || receiver_name.trim().length > 255 ||
        typeof receiver_address !== 'string' || !receiver_address.trim() || receiver_address.trim().length > 1000 ||
        typeof start_location !== 'string' || !start_location.trim() || start_location.trim().length > 255 ||
        typeof end_location !== 'string' || !end_location.trim() || end_location.trim().length > 255 ||
        !Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 8760 ||
        typeof weight !== 'string' || !weight.trim() || weight.trim().length > 50 ||
        typeof package_type !== 'string' || !packageTypes.has(package_type) ||
        (description !== undefined && (typeof description !== 'string' || description.length > 5000)) ||
        (status !== undefined && !shipmentStatuses.has(status))) {
      return res.status(400).json({ error: 'Enter valid sender and receiver details, route, transit duration, weight, and package type' });
    }

    let originCoordinates;
    let destinationCoordinates;
    try {
      originCoordinates = await geocodeAddress(sender_address.trim());
      if (!originCoordinates) {
        return res.status(422).json({ error: 'The sender address could not be found. Check it and try again.' });
      }
      destinationCoordinates = await geocodeAddress(receiver_address.trim());
      if (!destinationCoordinates) {
        return res.status(422).json({ error: 'The receiver address could not be found. Check it and try again.' });
      }
    } catch (geocodeError) {
      console.error('Shipment address geocoding error:', geocodeError.message);
      return res.status(502).json({ error: 'Address lookup is temporarily unavailable. Please try again shortly.' });
    }

    const expected_delivery = new Date(Date.now() + durationHours * 3600 * 1000);

    const result = await pool.query(
      `INSERT INTO shipments 
        (tracking_number, sender_name, sender_address, receiver_name, receiver_address,
         start_location, end_location, start_lat, start_lng, end_lat, end_lng,
         total_hours, weight, description, package_type, status, started_at, expected_delivery)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),$17)
       RETURNING *`,
      [cleanTrackingNumber, sender_name.trim(), sender_address.trim(), receiver_name.trim(), receiver_address.trim(),
       start_location.trim(), end_location.trim(), originCoordinates.lat, originCoordinates.lng,
       destinationCoordinates.lat, destinationCoordinates.lng, durationHours, weight.trim(), description?.trim() || null, package_type,
       status || 'In Transit', expected_delivery]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create shipment error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Tracking number already exists' });
    }
    res.status(500).json({ error: 'Server error creating shipment' });
  }
});

// Get all shipments (Admin)
app.get('/api/shipments', authMiddleware, async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shipments ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch shipments error:', err);
    res.status(500).json({ error: 'Server error fetching shipments' });
  }
});

// Update shipment (Admin)
app.put('/api/shipments/:tracking_number', authMiddleware, async (req, res) => {
  try {
    const { tracking_number } = req.params;
    const { is_paused, elapsed_hours, status } = req.body;

    if ((is_paused !== undefined && typeof is_paused !== 'boolean') ||
        (status !== undefined && !shipmentStatuses.has(status)) ||
        (elapsed_hours !== undefined &&
          (!Number.isFinite(Number(elapsed_hours)) || Number(elapsed_hours) < 0 || Number(elapsed_hours) > 8760))) {
      return res.status(400).json({ error: 'Invalid shipment update' });
    }

    const currentRes = await pool.query(
      'SELECT * FROM shipments WHERE LOWER(tracking_number)=LOWER($1)',
      [tracking_number.trim()]
    );
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Shipment not found' });
    }
    const s = currentRes.rows[0];

    let query = 'UPDATE shipments SET updated_at=NOW()';
    const params = [];
    let i = 1;

    if (is_paused !== undefined) {
      query += `, is_paused=$${i++}`;
      params.push(is_paused);

      if (is_paused && !s.is_paused) {
        query += `, elapsed_hours=GREATEST(0, LEAST(total_hours, EXTRACT(EPOCH FROM (NOW() - started_at)) / 3600))`;
        query += `, pause_started_at=NOW()`;
      } else if (!is_paused && s.is_paused && s.pause_started_at) {
        query += `, started_at = started_at + (NOW() - pause_started_at)`;
        query += `, expected_delivery = expected_delivery + (NOW() - pause_started_at)`;
        query += `, pause_started_at = NULL`;
      }
    }

    if (elapsed_hours !== undefined) {
      query += `, elapsed_hours=$${i++}`;
      params.push(Number(elapsed_hours));
    }
    if (status !== undefined) {
      query += `, status=$${i++}`;
      params.push(status);
    }

    query += ` WHERE tracking_number=$${i} RETURNING *`;
    params.push(tracking_number);

    const result = await pool.query(query, params);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update shipment error:', err);
    res.status(500).json({ error: 'Server error updating shipment' });
  }
});

// Delete shipment (Admin)
app.delete('/api/shipments/:tracking_number', authMiddleware, async (req, res) => {
  try {
    const { tracking_number } = req.params;
    const result = await pool.query(
      'DELETE FROM shipments WHERE LOWER(tracking_number)=LOWER($1) RETURNING tracking_number',
      [tracking_number.trim()]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shipment not found' });
    }
    res.json({ message: 'Shipment deleted successfully' });
  } catch (err) {
    console.error('Delete shipment error:', err);
    res.status(500).json({ error: 'Server error deleting shipment' });
  }
});

// ─── Public Tracking ───────────────────────────────────────────────────────────
app.get('/api/track/:tracking_number', async (req, res) => {
  try {
    const { tracking_number } = req.params;
    const cleanTrackingNumber = tracking_number.trim();
    if (!cleanTrackingNumber || cleanTrackingNumber.length > 50) {
      return res.status(400).json({ error: 'Enter a valid tracking number' });
    }
    const result = await pool.query(
      `SELECT tracking_number, start_location, end_location, start_lat, start_lng,
              end_lat, end_lng, sender_name, sender_address, receiver_name, receiver_address,
              total_hours, weight, package_type, description, status, is_paused, elapsed_hours,
              pause_started_at, started_at, expected_delivery, created_at
       FROM shipments WHERE LOWER(tracking_number) = LOWER($1)`,
      [cleanTrackingNumber]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tracking number not found' });
    }

    const s = result.rows[0];
    const now = Date.now();
    const startedAt = new Date(s.started_at).getTime();
    const totalHours = Number(s.total_hours);
    if (!Number.isFinite(startedAt) || !Number.isFinite(totalHours) || totalHours <= 0) {
      console.error(`Shipment ${s.tracking_number} has invalid tracking timing data.`);
      return res.status(500).json({ error: 'Shipment tracking data is unavailable' });
    }
    const totalMs = totalHours * 3600 * 1000;
    const pauseStartedAt = s.pause_started_at ? new Date(s.pause_started_at).getTime() : NaN;
    const elapsedMs = s.is_paused
      ? Number.isFinite(pauseStartedAt)
        ? Math.min(Math.max(pauseStartedAt - startedAt, 0), totalMs)
        : Number(s.elapsed_hours || 0) * 3600 * 1000
      : Math.min(Math.max(now - startedAt, 0), totalMs);

    let progress = Math.min(Math.max(elapsedMs / totalMs, 0), 1);
    if (s.status === 'Delivered') progress = 1;

    const startLat = Number(s.start_lat);
    const startLng = Number(s.start_lng);
    const endLat = Number(s.end_lat);
    const endLng = Number(s.end_lng);
    if (![startLat, startLng, endLat, endLng].every(Number.isFinite)) {
      console.error(`Shipment ${s.tracking_number} has invalid tracking coordinates.`);
      return res.status(500).json({ error: 'Shipment tracking data is unavailable' });
    }
    const currentLat = startLat + (endLat - startLat) * progress;
    const currentLng = startLng + (endLng - startLng) * progress;
    const storedExpectedDelivery = s.expected_delivery ? new Date(s.expected_delivery).getTime() : NaN;
    const expectedDeliveryAt = Number.isFinite(storedExpectedDelivery)
      ? storedExpectedDelivery
      : startedAt + totalMs;
    const adjustedExpectedDelivery = expectedDeliveryAt +
      (s.is_paused && Number.isFinite(pauseStartedAt) ? Math.max(now - pauseStartedAt, 0) : 0);

    res.json({
      tracking_number: s.tracking_number,
      start_location: s.start_location,
      end_location: s.end_location,
      sender_name: s.sender_name,
      sender_address: s.sender_address,
      receiver_name: s.receiver_name,
      receiver_address: s.receiver_address,
      weight: s.weight,
      package_type: s.package_type,
      description: s.description,
      status: s.status,
      is_paused: s.is_paused,
      is_moving: !s.is_paused && s.status !== 'Delivered' && progress < 1,
      progress: progress * 100,
      total_hours: totalHours,
      elapsed_seconds: elapsedMs / 1000,
      remaining_seconds: Math.max((totalMs - elapsedMs) / 1000, 0),
      current_lat: currentLat,
      current_lng: currentLng,
      start_lat: startLat,
      start_lng: startLng,
      end_lat: endLat,
      end_lng: endLng,
      expected_delivery: new Date(adjustedExpectedDelivery).toISOString(),
      started_at: s.started_at,
      pause_started_at: s.pause_started_at,
      created_at: s.created_at,
    });
  } catch (err) {
    console.error('Tracking query error:', err);
    res.status(500).json({ error: 'Server error retrieving tracking info' });
  }
});

// ─── Contact ───────────────────────────────────────────────────────────────────
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 255 ||
        typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
        email.trim().length > 255 ||
        typeof message !== 'string' || !message.trim() || message.trim().length > 10000 ||
        (phone !== undefined && (typeof phone !== 'string' || phone.length > 50)) ||
        (subject !== undefined && (typeof subject !== 'string' || subject.length > 255))) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }
    await pool.query(
      'INSERT INTO contact_messages (name, email, phone, subject, message) VALUES ($1,$2,$3,$4,$5)',
      [name.trim(), email.trim(), phone?.trim() || null, subject?.trim() || null, message.trim()]
    );
    res.status(201).json({ message: 'Message received. We will be in touch shortly.' });
  } catch (err) {
    console.error('Contact submit error:', err);
    res.status(500).json({ error: 'Server error submitting message' });
  }
});

// Get all contact messages (Admin)
app.get('/api/contact', authMiddleware, async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM contact_messages ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch contact messages error:', err);
    res.status(500).json({ error: 'Server error fetching contact messages' });
  }
});

// Get all chat sessions (Admin)
app.get('/api/chats', authMiddleware, async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT tracking_number, MAX(created_at) AS last_msg FROM chat_messages GROUP BY tracking_number ORDER BY last_msg DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch chats error:', err);
    res.status(500).json({ error: 'Server error fetching chat sessions' });
  }
});

// ─── Socket.IO Real-time Messaging ─────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    next();
    return;
  }
  try {
    socket.data.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid or expired authentication token'));
  }
});

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  socket.on('join_chat', async (payload = {}) => {
    try {
      const { tracking_number, isAdmin } = payload;
      if (typeof tracking_number !== 'string' || !tracking_number.trim() || tracking_number.length > 50) {
        return socket.emit('chat_error', { message: 'Enter a valid tracking number' });
      }
      if (isAdmin && !socket.data.admin) {
        return socket.emit('chat_error', { message: 'Admin authentication required' });
      }

      const shipment = await pool.query(
        'SELECT tracking_number FROM shipments WHERE LOWER(tracking_number) = LOWER($1)',
        [tracking_number.trim()]
      );
      if (shipment.rows.length === 0) {
        return socket.emit('chat_error', { message: 'Invalid tracking number' });
      }

      const room = shipment.rows[0].tracking_number;
      socket.join(room);
      console.log(`User joined chat room: ${room}`);

      const history = await pool.query(
        'SELECT * FROM chat_messages WHERE tracking_number=$1 ORDER BY created_at ASC',
        [room]
      );
      socket.emit('chat_history', history.rows);
    } catch (err) {
      console.error('Socket join_chat error:', err);
      socket.emit('chat_error', { message: 'Failed to load chat history' });
    }
  });

  socket.on('send_message', async (payload = {}) => {
    try {
      const { tracking_number, message } = payload;
      if (typeof tracking_number !== 'string' || typeof message !== 'string' ||
          !message.trim() || message.trim().length > 2000) {
        return socket.emit('chat_send_error', { message: 'Enter a message of 1 to 2000 characters' });
      }
      const shipment = await pool.query(
        'SELECT tracking_number FROM shipments WHERE LOWER(tracking_number)=LOWER($1)',
        [tracking_number.trim()]
      );
      if (shipment.rows.length === 0 || !socket.rooms.has(shipment.rows[0].tracking_number)) {
        return socket.emit('chat_send_error', { message: 'Join this shipment chat before sending a message' });
      }
      const room = shipment.rows[0].tracking_number;

      const result = await pool.query(
        'INSERT INTO chat_messages (tracking_number, sender, message) VALUES ($1, $2, $3) RETURNING *',
        [room, socket.data.admin ? 'admin' : 'user', message.trim()]
      );
      io.to(room).emit('receive_message', result.rows[0]);
    } catch (err) {
      console.error('Socket send_message error:', err);
      socket.emit('chat_send_error', { message: 'Message could not be sent. Please try again.' });
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────────
server.listen(port, () => {
  console.log(`🚀 Korvane API running on port ${port}`);
});