const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const configPath = path.join(__dirname, '../../config');
const localPaths = {
  clients: path.join(configPath, 'clients.json'),
  settings: path.join(configPath, 'settings.json'),
  audit_logs: path.join(configPath, 'audit_logs.json')
};
const defaults = { clients: [], settings: {}, audit_logs: [] };
let adapterPromise;
let adapter;
let supabaseClient;
let localOnly = false;
let fallbackLogged = false;

function readLocal(key) {
  const filePath = localPaths[key];
  if (!filePath || !fs.existsSync(filePath)) return defaults[key];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeLocal(key, value) {
  const filePath = localPaths[key];
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function disableCloud(err) {
  if (!fallbackLogged) {
    console.error(`[Storage] Cloud database unavailable; using local JSON storage: ${err.message}`);
    fallbackLogged = true;
  }
  adapter = null;
  localOnly = true;
}

function configureSupabase(client) {
  supabaseClient = client;
}

function clientFromRow(row) {
  return {
    id: row.client_key,
    caId: row.ca_id || undefined,
    uploadToken: row.upload_token,
    name: row.name,
    businessName: row.business_name,
    email: row.email || '',
    phone: row.phone || '',
    gstin: row.gstin || '',
    status: row.status,
    documentChecklist: row.document_checklist || [],
    dueDayOfMonth: row.due_day_of_month || 5,
    autoRemind: row.auto_remind !== false,
    ...(row.last_reminder_sent ? { lastReminderSent: row.last_reminder_sent } : {})
  };
}

function clientToRow(client) {
  return {
    client_key: client.id,
    ca_id: client.caId || null,
    upload_token: client.uploadToken,
    name: client.name,
    business_name: client.businessName,
    email: client.email || '',
    phone: client.phone || '',
    gstin: client.gstin || '',
    status: client.status,
    document_checklist: client.documentChecklist || [],
    due_day_of_month: client.dueDayOfMonth || 5,
    auto_remind: client.autoRemind !== false,
    last_reminder_sent: client.lastReminderSent || null
  };
}

function mergeTenantClients(current, caId, clients) {
  const otherTenants = current.filter(client => client.caId !== caId);
  return [...otherTenants, ...clients];
}

function ensureClientUploadTokens(clients) {
  let changed = false;
  const updatedClients = clients.map(client => {
    if (client.uploadToken) return client;
    changed = true;
    return { ...client, uploadToken: crypto.randomBytes(32).toString('hex') };
  });
  if (changed) writeLocal('clients', updatedClients);
  return { clients: updatedClients, changed };
}

async function readClientsForCa(caId) {
  if (!caId) return readState('clients');
  const connection = await getAdapter();
  if (process.env.SUPABASE_URL && (!connection || connection.type !== 'supabase')) {
    throw new Error('Supabase is unavailable; refusing to read tenant data from local fallback storage.');
  }
  if (connection && connection.type === 'supabase') {
    const { data, error } = await supabaseClient
      .from('clients')
      .select('client_key, ca_id, upload_token, name, business_name, email, phone, gstin, status, document_checklist, due_day_of_month, auto_remind, last_reminder_sent')
      .eq('ca_id', caId)
      .order('client_key');
    if (error) throw error;
    return (data || []).map(clientFromRow);
  }
  return (await readState('clients')).filter(client => client.caId === caId);
}

async function readClientsForReminders(caId) {
  const connection = await getAdapter();
  if (process.env.SUPABASE_URL && (!connection || connection.type !== 'supabase')) {
    throw new Error('Supabase is unavailable; refusing to send reminders from local fallback data.');
  }
  if (connection && connection.type === 'supabase') {
    let query = supabaseClient
      .from('clients')
      .select('client_key, ca_id, upload_token, name, business_name, email, phone, gstin, status, document_checklist, due_day_of_month, auto_remind, last_reminder_sent')
      .neq('status', 'Completed')
      .neq('status', 'Submitted');
    if (caId) query = query.eq('ca_id', caId);
    else query = query.not('ca_id', 'is', null);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(clientFromRow).filter(client =>
      !['completed', 'submitted'].includes(String(client.status || '').toLowerCase()) &&
      (client.documentChecklist || []).some(item => !item.submitted)
    );
  }
  return (await readState('clients')).filter(client =>
    (!caId || client.caId === caId) &&
    !['completed', 'submitted'].includes(String(client.status || '').toLowerCase()) &&
    (client.documentChecklist || []).some(item => !item.submitted)
  );
}

async function readSettingsForCa(caId) {
  if (!caId) return readState('settings');
  const connection = await getAdapter();
  if (process.env.SUPABASE_URL && (!connection || connection.type !== 'supabase')) {
    throw new Error('Supabase is unavailable; refusing to read tenant settings from local fallback storage.');
  }
  if (connection && connection.type === 'supabase') {
    const { data, error } = await supabaseClient
      .from('practice_settings')
      .select('settings')
      .eq('ca_id', caId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data.settings || {};
    const initialSettings = readLocal('settings');
    const { error: insertError } = await supabaseClient.from('practice_settings').upsert({ ca_id: caId, settings: initialSettings });
    if (insertError) throw insertError;
    return initialSettings;
  }
  return readState('settings');
}

async function writeSettingsForCa(caId, settings) {
  if (!caId) return writeState('settings', settings);
  const connection = await getAdapter();
  if (process.env.SUPABASE_URL && (!connection || connection.type !== 'supabase')) {
    throw new Error('Supabase is unavailable; refusing to write tenant settings to local fallback storage.');
  }
  if (connection && connection.type === 'supabase') {
    const { error } = await supabaseClient.from('practice_settings').upsert({
      ca_id: caId,
      settings,
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
    return;
  }
  return writeState('settings', settings);
}

async function writeClientsForCa(caId, clients) {
  if (!caId) return writeState('clients', clients);
  const connection = await getAdapter();
  if (process.env.SUPABASE_URL && (!connection || connection.type !== 'supabase')) {
    throw new Error('Supabase is unavailable; refusing to write tenant data to local fallback storage.');
  }
  if (connection && connection.type === 'supabase') {
    const { error } = await supabaseClient.from('clients').upsert(clients.map(clientToRow), { onConflict: 'client_key' });
    if (error) throw error;
    writeLocal('clients', mergeTenantClients(readLocal('clients'), caId, clients));
    return;
  }
  const allClients = await readState('clients');
  await writeState('clients', mergeTenantClients(allClients, caId, clients));
}

async function insertClientsForCa(caId, clients) {
  const connection = await getAdapter();
  if (process.env.SUPABASE_URL && (!connection || connection.type !== 'supabase')) {
    throw new Error('Supabase is unavailable; refusing to insert tenant data into local fallback storage.');
  }
  if (connection && connection.type === 'supabase') {
    const { error } = await supabaseClient.from('clients').insert(clients.map(clientToRow));
    if (error) throw error;
    writeLocal('clients', [...readLocal('clients'), ...clients]);
    return;
  }
  const allClients = await readState('clients');
  await writeState('clients', [...allClients, ...clients]);
}

async function readActivityLogs(caId) {
  const connection = await getAdapter();
  if (process.env.SUPABASE_URL && (!connection || connection.type !== 'supabase')) {
    throw new Error('Supabase is unavailable; activity history cannot be verified.');
  }
  if (connection && connection.type === 'supabase') {
    let query = supabaseClient
      .from('activity_logs')
      .select('id, ca_id, email, event_type, action, client_id, client_name, details, created_at')
      .order('created_at', { ascending: false })
      .limit(500);
    if (caId) query = query.eq('ca_id', caId);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(row => ({
      id: row.id,
      caId: row.ca_id,
      email: row.email,
      eventType: row.event_type,
      action: row.action,
      clientId: row.client_id,
      clientName: row.client_name,
      details: row.details,
      timestamp: row.created_at
    }));
  }
  const logs = await readState('audit_logs');
  return caId ? logs.filter(log => log.caId === caId) : logs;
}

async function insertActivityLog(log) {
  const connection = await getAdapter();
  if (process.env.SUPABASE_URL && (!connection || connection.type !== 'supabase')) {
    throw new Error('Supabase is unavailable; audit event was not recorded.');
  }
  if (connection && connection.type === 'supabase') {
    const { error } = await supabaseClient.from('activity_logs').insert({
      id: log.id,
      ca_id: log.caId || null,
      email: log.email || '',
      event_type: log.eventType,
      action: log.action || log.eventType,
      client_id: log.clientId,
      client_name: log.clientName || 'System',
      details: log.details || '',
      created_at: log.timestamp
    });
    if (error) throw error;
    return log;
  }

  const logs = await readState('audit_logs');
  logs.unshift(log);
  if (logs.length > 500) logs.length = 500;
  await writeState('audit_logs', logs);
  return log;
}

async function connectAdapter() {
  if (localOnly) return null;

  if (process.env.SUPABASE_URL) {
    const baseUrl = process.env.SUPABASE_URL.replace(/\/+$/, '');
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!supabaseClient) throw new Error('Supabase client has not been initialized.');
    if (!apiKey) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY to use Supabase.');
    return {
      type: 'supabase',
      async get(key) {
        if (key === 'clients') {
          const { data, error } = await supabaseClient
            .from('clients')
            .select('client_key, ca_id, upload_token, name, business_name, email, phone, gstin, status, document_checklist, due_day_of_month, auto_remind, last_reminder_sent')
            .order('client_key');
          if (error) throw error;
          if (!data.length) return null;
          return data.map(clientFromRow);
        }
        const url = `${baseUrl}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=value`;
        const response = await fetch(url, {
          headers: {
            apikey: apiKey,
            Authorization: `Bearer ${apiKey}`
          },
          signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) throw new Error(`Supabase read failed (${response.status}).`);
        const rows = await response.json();
        return rows.length ? rows[0].value : null;
      },
      async set(key, value) {
        if (key === 'clients') {
          if (!value.length) return;
          const { error } = await supabaseClient.from('clients').upsert(value.map(clientToRow), { onConflict: 'client_key' });
          if (error) throw error;
          return;
        }
        const response = await fetch(`${baseUrl}/rest/v1/app_state?on_conflict=key`, {
          method: 'POST',
          headers: {
            apikey: apiKey,
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify({ key, value }),
          signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) throw new Error(`Supabase write failed (${response.status}).`);
      }
    };
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  if (/^mongodb(?:\+srv)?:\/\//i.test(connectionString)) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 5000, timeoutMS: 10000 });
    await client.connect();
    const databaseName = new URL(connectionString).pathname.slice(1) || 'ca_automation_hub';
    const collection = client.db(databaseName).collection('app_state');
    return {
      type: 'mongodb',
      async get(key) {
        const record = await collection.findOne({ _id: key });
        return record ? record.value : null;
      },
      async set(key, value) {
        await collection.updateOne({ _id: key }, { $set: { value } }, { upsert: true });
      }
    };
  }

  if (/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, query_timeout: 10000 });
    await pool.query('CREATE TABLE IF NOT EXISTS app_state (key text PRIMARY KEY, value jsonb NOT NULL)');
    return {
      type: 'postgres',
      async get(key) {
        const result = await pool.query('SELECT value FROM app_state WHERE key = $1', [key]);
        return result.rows.length ? result.rows[0].value : null;
      },
      async set(key, value) {
        await pool.query(
          'INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
          [key, JSON.stringify(value)]
        );
      }
    };
  }

  throw new Error('DATABASE_URL must use a PostgreSQL or MongoDB connection string.');
}

async function getAdapter() {
  if (localOnly) return null;
  if (!adapterPromise) {
    adapterPromise = connectAdapter()
      .then(connection => {
        adapter = connection;
        if (connection) console.log(`[Storage] Using ${connection.type} storage adapter.`);
        return connection;
      })
      .catch(err => {
        disableCloud(err);
        return null;
      });
  }
  return adapterPromise;
}

async function readState(key) {
  const connection = await getAdapter();
  if (!connection) {
    if (process.env.SUPABASE_URL) throw new Error('Supabase is unavailable; refusing local fallback reads.');
    const value = readLocal(key);
    return key === 'clients' ? ensureClientUploadTokens(value).clients : value;
  }

  try {
    const value = await connection.get(key);
    if (value !== null) {
      if (key === 'clients') {
        const ensured = ensureClientUploadTokens(value);
        if (ensured.changed) await connection.set(key, ensured.clients);
        writeLocal(key, ensured.clients);
        return ensured.clients;
      }
      writeLocal(key, value);
      return value;
    }

    if (key === 'clients' && process.env.SUPABASE_URL) return [];

    const initialValue = readLocal(key);
    const seededValue = key === 'clients' ? ensureClientUploadTokens(initialValue).clients : initialValue;
    await connection.set(key, seededValue);
    return seededValue;
  } catch (err) {
    disableCloud(err);
    if (process.env.SUPABASE_URL) throw new Error('Supabase is unavailable; refusing local fallback reads.');
    return readLocal(key);
  }
}

async function writeState(key, value) {
  const connection = await getAdapter();
  if (!connection) {
    if (process.env.SUPABASE_URL) throw new Error('Supabase is unavailable; refusing local fallback writes.');
    writeLocal(key, value);
    return;
  }

  try {
    await connection.set(key, value);
    writeLocal(key, value);
  } catch (err) {
    disableCloud(err);
    if (process.env.SUPABASE_URL) throw new Error('Supabase is unavailable; refusing local fallback writes.');
    writeLocal(key, value);
  }
}

function getStorageType() {
  if (localOnly) return 'local';
  if (process.env.SUPABASE_URL) return 'supabase';
  if (process.env.DATABASE_URL) {
    return /^mongodb(?:\+srv)?:\/\//i.test(process.env.DATABASE_URL) ? 'mongodb' : 'postgres';
  }
  return 'local';
}

module.exports = { readState, writeState, readClientsForCa, readClientsForReminders, readSettingsForCa, writeSettingsForCa, writeClientsForCa, insertClientsForCa, readActivityLogs, insertActivityLog, getStorageType, configureSupabase };
