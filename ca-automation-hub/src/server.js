const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const XLSX = require('xlsx');
const cron = require('node-cron');
const { authorizeWorkspaceUser, isWorkspaceOAuthRequired } = require('./lib/tenantAuth');
const {
  handleInboundUpdate,
  handleSubmitDocuments,
  calculateDashboardStats,
  getClients,
  findClientByPortalToken
} = require('./parser/webhookHandler');
const { triggerReminders, triggerScheduledReminders, computeTargetDueDates } = require('./reminders/engine');
const { getAuditLogs, logActivity } = require('./lib/auditLogger');
const { readState, writeState, readClientsForCa, readSettingsForCa, writeSettingsForCa, writeClientsForCa, insertClientsForCa, getStorageType, configureSupabase } = require('./lib/storage');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const uploadsPath = path.join(__dirname, '../data/uploads');
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
let supabaseClient;

if (process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) {
  supabaseClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  configureSupabase(supabaseClient);
}

app.use(cors());
morgan.token('safe-url', req => {
  const requestUrl = new URL(req.originalUrl || req.url, 'http://localhost');
  if (requestUrl.searchParams.has('password')) requestUrl.searchParams.set('password', '[redacted]');
  return `${requestUrl.pathname}${requestUrl.search}`;
});
app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length]'));
app.use(bodyParser.json({ limit: '16mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/auth/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    requireOAuth: isWorkspaceOAuthRequired(process.env.SUPABASE_URL, process.env.NODE_ENV)
  });
});

// Middleware: Basic Authentication for Dashboard API routes
async function checkAuth(req, res, next) {
  if (isWorkspaceOAuthRequired(process.env.SUPABASE_URL, process.env.NODE_ENV)) {
    if (!supabaseClient) return res.status(503).json({ error: 'Workspace sign-in is unavailable. Contact your administrator.' });
    try {
      const bearerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const identity = await authorizeWorkspaceUser(supabaseClient, bearerToken);
      req.caId = identity.caId;
      req.userEmail = identity.email;
      req.practiceName = identity.practiceName;
      return next();
    } catch (err) {
      return res.status(err.status || 503).json({
        error: err.status === 403 ? 'Access Restricted. Contact Administrator.' : err.message
      });
    }
  }

  try {
    const settings = await readState('settings');
    if (!settings.auth || !settings.auth.enabled) return next();

    const firmPassword = process.env.FIRM_PASSWORD || settings.auth.firmPassword;
    const authorization = req.headers.authorization || '';
    const suppliedPasswords = [
      authorization.replace(/^Bearer\s+/i, ''),
      req.headers['x-firm-password'],
      req.query.password
    ];

    if (firmPassword && suppliedPasswords.some(password => password === firmPassword)) {
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized: Access denied' });
  } catch (err) {
    return next(err);
  }
}

function requireTenantAuth(req, res, next) {
  if (!req.caId && isWorkspaceOAuthRequired(process.env.SUPABASE_URL, process.env.NODE_ENV)) return res.status(401).json({ error: 'Sign in with Google to manage tenant client data.' });
  next();
}

app.get('/api/auth/session', checkAuth, requireTenantAuth, async (req, res) => {
  try {
    await logActivity({
      caId: req.caId,
      email: req.userEmail,
      eventType: 'WORKSPACE_ACCESS',
      details: 'Authorized workspace session verified.'
    });
    res.json({ authorized: true, caId: req.caId || null, email: req.userEmail || null, practiceName: req.practiceName || '' });
  } catch (err) {
    res.status(503).json({ error: 'Workspace audit storage is unavailable.' });
  }
});

function verifyInboundWebhook(req, res, next) {
  const expected = process.env.INBOUND_WEBHOOK_SECRET || '';
  const supplied = req.get('x-webhook-secret') || '';
  if (!expected) return res.status(503).json({ error: 'Inbound webhook is not configured.' });
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return res.status(401).json({ error: 'Unauthorized webhook request.' });
  }
  next();
}

// Protected Dashboard API Routes
app.get('/api/clients', checkAuth, requireTenantAuth, async (req, res) => {
  try {
    const clients = await readClientsForCa(req.caId);
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read clients configuration' });
  }
});

app.post('/api/clients', checkAuth, requireTenantAuth, async (req, res) => {
  try {
    const { name, businessName, email = '', phone = '', gstin = '', documentTitles } = req.body;
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const cleanBusinessName = typeof businessName === 'string' ? businessName.trim() : '';
    const cleanEmail = typeof email === 'string' ? email.trim() : '';
    const cleanPhone = typeof phone === 'string' ? phone.trim() : '';
    const cleanGstin = typeof gstin === 'string' ? gstin.trim().toUpperCase() : '';

    if (!cleanName || !cleanBusinessName) {
      return res.status(400).json({ error: 'Client name and business name are required.' });
    }
    if (cleanName.length > 100 || cleanBusinessName.length > 150 || cleanEmail.length > 150 || cleanPhone.length > 40) {
      return res.status(400).json({ error: 'One or more client fields exceed the allowed length.' });
    }
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (cleanGstin && !/^\d{2}[A-Z0-9]{13}$/.test(cleanGstin)) {
      return res.status(400).json({ error: 'GSTIN must be 15 characters.' });
    }
    if (!Array.isArray(documentTitles) || documentTitles.length < 1 || documentTitles.length > 20 ||
      documentTitles.some(title => typeof title !== 'string' || !title.trim() || title.trim().length > 100)) {
      return res.status(400).json({ error: 'Add between 1 and 20 document requirements, each 1–100 characters.' });
    }

    const clients = await readClientsForCa(req.caId);
    if (cleanGstin && clients.some(client => String(client.gstin || '').toUpperCase() === cleanGstin)) {
      return res.status(409).json({ error: 'A client with this GSTIN already exists.' });
    }
    const client = {
      id: `client-${crypto.randomUUID()}`,
      uploadToken: crypto.randomBytes(32).toString('hex'),
      name: cleanName,
      businessName: cleanBusinessName,
      email: cleanEmail,
      phone: cleanPhone,
      gstin: cleanGstin,
      caId: req.caId,
      status: 'Pending',
      dueDayOfMonth: 5,
      autoRemind: true,
      documentChecklist: documentTitles.map((title, index) => ({
        id: `document-${index + 1}`,
        title: title.trim(),
        submitted: false
      }))
    };
    clients.push(client);
    await writeClientsForCa(req.caId, clients);
    await logActivity({
      caId: req.caId,
      email: req.userEmail,
      eventType: 'CLIENT_CREATED',
      clientId: client.id,
      clientName: client.businessName,
      details: `Client added with ${client.documentChecklist.length} requested document types.`
    });
    res.status(200).json({ success: true, client });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add client.' });
  }
});

app.post('/api/clients/import', checkAuth, requireTenantAuth, importUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose an .xlsx or .csv file to import.' });
    const extension = path.extname(req.file.originalname).toLowerCase();
    if (!['.xlsx', '.csv'].includes(extension)) return res.status(400).json({ error: 'Only .xlsx and .csv files are supported.' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return res.status(400).json({ error: 'The import file does not contain a worksheet.' });
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (rows.length > 500) return res.status(400).json({ error: 'Import at most 500 clients at a time.' });
    const normalizeHeader = value => String(value).trim().toLowerCase().replace(/\s+/g, ' ');
    const clients = [];
    const seenGstins = new Set();
    const defaultDocuments = ['Sales Register', 'Bank Statement', 'Purchase Invoices'];

    for (let index = 0; index < rows.length; index++) {
      const row = Object.fromEntries(Object.entries(rows[index]).map(([key, value]) => [normalizeHeader(key), String(value).trim()]));
      const name = row['contact name'] || '';
      const businessName = row['business name'] || '';
      const email = row.email || '';
      const phone = row.phone || '';
      const gstin = (row.gstin || '').toUpperCase();
      if (!name || !businessName) return res.status(400).json({ error: `Row ${index + 2}: Business Name and Contact Name are required.` });
      if (name.length > 100 || businessName.length > 150 || email.length > 150 || phone.length > 40 || (gstin && !/^\d{2}[A-Z0-9]{13}$/.test(gstin))) {
        return res.status(400).json({ error: `Row ${index + 2}: one or more fields are invalid or too long.` });
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: `Row ${index + 2}: enter a valid email address.` });
      if (gstin && seenGstins.has(gstin)) return res.status(400).json({ error: `Row ${index + 2}: duplicate GSTIN in this file.` });
      if (gstin) seenGstins.add(gstin);
      clients.push({
        id: `client-${crypto.randomUUID()}`, uploadToken: crypto.randomBytes(32).toString('hex'), caId: req.caId, name, businessName, email, phone, gstin,
        status: 'Pending', dueDayOfMonth: 5, autoRemind: true,
        documentChecklist: defaultDocuments.map((title, documentIndex) => ({
          id: `document-${documentIndex + 1}`, title, submitted: false
        }))
      });
    }
    if (!clients.length) return res.status(400).json({ error: 'The file has no client rows to import.' });

    const existing = await readClientsForCa(req.caId);
    const existingGstins = new Set(existing.map(client => String(client.gstin || '').toUpperCase()).filter(Boolean));
    const duplicate = clients.find(client => client.gstin && existingGstins.has(client.gstin));
    if (duplicate) return res.status(409).json({ error: `GSTIN ${duplicate.gstin} already exists in your client list.` });
    await insertClientsForCa(req.caId, clients);
    await logActivity({ caId: req.caId, email: req.userEmail, eventType: 'CLIENTS_IMPORTED', details: `${clients.length} client records imported.` });
    res.status(201).json({ success: true, importedCount: clients.length, clients });
  } catch (err) {
    res.status(500).json({ error: 'Failed to import clients.' });
  }
});

app.get('/api/stats', checkAuth, requireTenantAuth, async (req, res) => {
  try {
    const stats = await calculateDashboardStats(await readClientsForCa(req.caId));
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate stats' });
  }
});

app.get('/api/audit-logs', checkAuth, requireTenantAuth, async (req, res) => {
  res.json(await getAuditLogs(req.caId));
});

app.get('/api/settings', checkAuth, async (req, res) => {
  try {
    const settings = await readSettingsForCa(req.caId);
    const dueDates = computeTargetDueDates(settings);
    const { auth, ...publicSettings } = settings;
    res.json({ ...publicSettings, computedDueDates: dueDates });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read settings configuration' });
  }
});

app.post('/api/settings', checkAuth, async (req, res) => {
  try {
    const newSettings = await readSettingsForCa(req.caId);
    const { firmName, reminders, statutoryCalendar, googleSheets, n8n, baseUrl } = req.body;
    if (firmName !== undefined) newSettings.firmName = String(firmName).trim().slice(0, 70);
    if (reminders !== undefined) {
      if (!Number.isInteger(reminders.intervalDays) || reminders.intervalDays < 1 || reminders.intervalDays > 90) {
        return res.status(400).json({ error: 'Reminder interval must be between 1 and 90 days.' });
      }
      newSettings.reminders = {
        ...newSettings.reminders,
        intervalDays: reminders.intervalDays,
        autoRemindersEnabled: Boolean(reminders.autoRemindersEnabled)
      };
    }
    if (statutoryCalendar !== undefined) newSettings.statutoryCalendar = statutoryCalendar;
    if (googleSheets !== undefined) newSettings.googleSheets = googleSheets;
    if (n8n !== undefined) {
      const webhookUrl = String(n8n.webhookUrl || '').trim();
      if (webhookUrl) {
        try {
          if (!['http:', 'https:'].includes(new URL(webhookUrl).protocol)) throw new Error('invalid protocol');
        } catch (err) {
          return res.status(400).json({ error: 'Enter a valid HTTP or HTTPS reminder workflow URL.' });
        }
      }
      newSettings.n8n = { ...newSettings.n8n, webhookUrl };
    }
    if (baseUrl !== undefined) {
      const publicBaseUrl = String(baseUrl).trim().replace(/\/+$/, '');
      try {
        if (!['http:', 'https:'].includes(new URL(publicBaseUrl).protocol)) throw new Error('invalid protocol');
      } catch (err) {
        return res.status(400).json({ error: 'Enter a valid HTTP or HTTPS public portal URL.' });
      }
      newSettings.baseUrl = publicBaseUrl;
    }
    await writeSettingsForCa(req.caId, newSettings);
    await logActivity({
      caId: req.caId,
      email: req.userEmail,
      eventType: 'SETTINGS_UPDATED',
      details: 'Workspace settings updated.'
    });
    const { auth, ...publicSettings } = newSettings;
    res.status(200).json({ message: 'Settings saved successfully', settings: publicSettings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Public / Client API Routes (No Auth for portal access & submissions)
app.get('/api/clients/:id/workspace', checkAuth, requireTenantAuth, async (req, res) => {
  try {
    const clients = await readClientsForCa(req.caId);
    const client = clients.find(entry => entry.id === req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found.' });
    res.json({
      id: client.id,
      name: client.name,
      businessName: client.businessName,
      email: client.email,
      phone: client.phone,
      gstin: client.gstin,
      documentChecklist: (client.documentChecklist || []).map(item => ({
        id: item.id,
        title: item.title || item.label || item.id,
        submitted: Boolean(item.submitted),
        hasUpload: Boolean(item.storedAs)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read client details.' });
  }
});

app.get('/api/clients/:id', async (req, res) => {
  try {
    const clients = await getClients();
    const client = findClientByPortalToken(clients, req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({
      portalToken: client.uploadToken,
      name: client.name,
      businessName: client.businessName,
      gstin: client.gstin,
      documentChecklist: (client.documentChecklist || []).map(item => ({
        id: item.id,
        title: item.title || item.label || item.id,
        submitted: Boolean(item.submitted)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read client' });
  }
});

app.get('/api/clients/:id/documents/:itemId', checkAuth, requireTenantAuth, async (req, res) => {
  try {
    const clients = await readClientsForCa(req.caId);
    const client = clients.find(c => c.id === req.params.id);
    const item = client && (client.documentChecklist || []).find(entry => entry.id === req.params.itemId);
    if (!item || !item.storedAs) return res.status(404).json({ error: 'Uploaded document not found' });

    const documentPath = path.join(uploadsPath, path.basename(item.storedAs));
    if (!fs.existsSync(documentPath)) return res.status(404).json({ error: 'Uploaded document file is missing' });
    res.download(documentPath, item.fileName || 'client-document');
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve uploaded document' });
  }
});

app.put('/api/clients/:id/checklist', checkAuth, requireTenantAuth, async (req, res) => {
  try {
    const clients = await readClientsForCa(req.caId);
    const index = clients.findIndex(c => c.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Client not found' });
    const requestedChecklist = req.body.documentChecklist;
    if (!Array.isArray(requestedChecklist) || requestedChecklist.length < 1 || requestedChecklist.length > 20) {
      return res.status(400).json({ error: 'A checklist must contain between 1 and 20 items.' });
    }

    const client = clients[index];
    const currentItems = client.documentChecklist || [];
    const currentById = new Map(currentItems.map(item => [item.id, item]));
    const requestedIds = new Set();
    const updatedItems = [];
    for (const requestedItem of requestedChecklist) {
      const requestedId = typeof requestedItem.id === 'string' ? requestedItem.id : '';
      const title = typeof requestedItem.title === 'string' ? requestedItem.title.trim() : '';
      if (!title || title.length > 100) return res.status(400).json({ error: 'Each checklist item needs a title of 1–100 characters.' });
      if (requestedId && requestedIds.has(requestedId)) return res.status(400).json({ error: 'Checklist item IDs must be unique.' });
      if (requestedId) requestedIds.add(requestedId);

      const existing = currentById.get(requestedId);
      updatedItems.push(existing
        ? { ...existing, title }
        : { id: `document-${crypto.randomUUID()}`, title, submitted: false });
    }
    const removedUploadedItem = currentItems.some(item => item.storedAs && !requestedIds.has(item.id));
    if (removedUploadedItem) return res.status(400).json({ error: 'Uploaded checklist items cannot be removed.' });

    client.documentChecklist = updatedItems;
    const submittedCount = updatedItems.filter(item => item.submitted).length;
    client.status = submittedCount === updatedItems.length ? 'Completed' : submittedCount ? 'Partially Submitted' : 'Pending';
    await writeClientsForCa(req.caId, clients);
    await logActivity({
      caId: req.caId,
      email: req.userEmail,
      eventType: 'CHECKLIST_UPDATED',
      clientId: clients[index].id,
      clientName: clients[index].businessName,
      details: 'Client document checklist updated.'
    });
    res.json({
      success: true,
      documentChecklist: client.documentChecklist.map(item => ({
        id: item.id,
        title: item.title,
        submitted: Boolean(item.submitted),
        hasUpload: Boolean(item.storedAs)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update client checklist' });
  }
});

// Public Mobile Upload Portal Route
app.get('/upload/:clientId', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/upload-portal.html'));
});

// Public Submit Documents Endpoint
app.post('/api/submit-documents', async (req, res) => {
  try {
    const result = await handleSubmitDocuments(req.body);
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function handleTriggerRemindersRoute(req, res) {
  try {
    await logActivity({
      caId: req.caId,
      email: req.userEmail,
      eventType: 'REMINDER_REQUESTED',
      details: 'Manual reminder dispatch requested from the dashboard.'
    });
    const result = await triggerReminders({ caId: req.caId });
    res.status(200).json({ message: 'Reminders triggered successfully', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.post('/api/trigger-reminders', checkAuth, requireTenantAuth, handleTriggerRemindersRoute);
app.post('/api/reminders/trigger', checkAuth, requireTenantAuth, handleTriggerRemindersRoute);
app.post('/api/send-reminders', checkAuth, requireTenantAuth, handleTriggerRemindersRoute);

app.post('/api/webhook/inbound', verifyInboundWebhook, async (req, res) => {
  const result = await handleInboundUpdate(req.body);
  res.status(result.success ? 200 : 400).json(result);
});

app.get('/health', async (req, res) => {
  try {
    await readState('settings');
    res.json({ status: 'ok', storage: getStorageType() });
  } catch (err) {
    res.status(503).json({ status: 'error', error: 'Application storage is unavailable.' });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.use((err, req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(err.status || 400).json({ error: err.message || 'Invalid request' });
  }
  next(err);
});

async function startServer() {
  if (process.env.SUPABASE_URL) {
    try {
      await readState('clients');
      if (getStorageType() === 'supabase') {
        console.log('[Storage] Supabase clients table is available.');
      }
    } catch (err) {
      console.error('[Storage] Supabase is unavailable; protected data routes will fail closed:', err.message);
    }
  }

  cron.schedule('0 9 * * *', async () => {
    try {
      const result = await triggerScheduledReminders();
      console.log(`[Reminder Engine] Scheduled dispatch complete: ${result.dispatchedCount} sent.`);
    } catch (err) {
      console.error('[Reminder Engine] Scheduled dispatch failed:', err.message);
    }
  });

  app.listen(PORT, () => {
    console.log(`CA Automation Hub running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to initialize application storage:', err.message);
  process.exitCode = 1;
});
