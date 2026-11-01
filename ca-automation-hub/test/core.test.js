const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateDashboardStats } = require('../src/parser/webhookHandler');
const { computeTargetDueDates, shouldSendScheduledReminder, resolveNotificationChannels } = require('../src/reminders/engine');
const { parseFinancialDocument } = require('../src/parser');
const { getStorageType, mergeClientUpdates } = require('../src/lib/storage');
const { buildReminderEmail } = require('../src/lib/email');
const { authorizeWorkspaceUser, isWorkspaceOAuthRequired } = require('../src/lib/tenantAuth');
const { findClientByPortalToken } = require('../src/parser/webhookHandler');
const { buildWhatsAppWebhookPayload, buildMetaTemplatePayload } = require('../src/lib/whatsapp');
const { sanitizePracticeSettings } = require('../src/lib/settings');

test('dashboard statistics count completed and outstanding clients', async () => {
  const stats = await calculateDashboardStats([
    { status: 'Completed' },
    { status: 'Pending' },
    { status: 'Partially Submitted' }
  ]);

  assert.deepEqual(stats, { total: 3, completed: 1, pending: 2 });
});

test('statutory due date calculation returns the configured calendar entries', () => {
  const dueDates = computeTargetDueDates({
    statutoryCalendar: [
      { id: 'gst-r1', label: 'GST R1', dueDay: 11, frequency: 'monthly' },
      { id: 'itr', label: 'ITR', dueDay: 31, dueMonth: 7, frequency: 'yearly' }
    ]
  });

  assert.equal(dueDates.length, 2);
  assert.deepEqual(dueDates.map(item => item.id), ['gst-r1', 'itr']);
  for (const item of dueDates) {
    assert.match(item.dueDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(Number.isInteger(item.daysRemaining), true);
  }
});

test('scheduled reminders respect client due day, opt-out, and completion', () => {
  const dueToday = new Date(2026, 9, 5);
  const client = { status: 'Pending', dueDayOfMonth: 5, autoRemind: true, documentChecklist: [{ submitted: false }] };

  assert.equal(shouldSendScheduledReminder(client, dueToday), true);
  assert.equal(shouldSendScheduledReminder({ ...client, dueDayOfMonth: 6 }, dueToday), false);
  assert.equal(shouldSendScheduledReminder({ ...client, autoRemind: false }, dueToday), false);
  assert.equal(shouldSendScheduledReminder({ ...client, status: 'Completed' }, dueToday), false);
});

test('scheduled reminders honor primary day and recurring interval', () => {
  const client = {
    status: 'Pending',
    dueDayOfMonth: 5,
    autoRemind: true,
    documentChecklist: [{ submitted: false }]
  };
  const reminderSettings = { primaryDayOfMonth: 3, intervalDays: 2 };

  assert.equal(shouldSendScheduledReminder(client, new Date(2026, 10, 2), reminderSettings), false);
  assert.equal(shouldSendScheduledReminder(client, new Date(2026, 10, 3), reminderSettings), true);
  assert.equal(shouldSendScheduledReminder({ ...client, lastReminderSent: '2026-11-03T09:00:00.000Z' }, new Date(2026, 10, 4), reminderSettings), false);
  assert.equal(shouldSendScheduledReminder({ ...client, lastReminderSent: '2026-11-03T09:00:00.000Z' }, new Date(2026, 10, 5), reminderSettings), true);
});

test('notification preferences select email, WhatsApp, both, or escalation channels', () => {
  const settings = { reminders: { defaultNotificationChannel: 'email_only', escalationAfterReminders: 2, escalationAfterDays: 3, primaryDayOfMonth: 3 } };
  const client = { reminderCount: 0 };

  assert.deepEqual(resolveNotificationChannels(client, settings, new Date(2026, 10, 4)), ['email']);
  assert.deepEqual(resolveNotificationChannels({ notificationChannel: 'whatsapp_only' }, settings), ['whatsapp']);
  assert.deepEqual(resolveNotificationChannels({ notificationChannel: 'both' }, settings), ['email', 'whatsapp']);
  assert.deepEqual(resolveNotificationChannels({ notificationChannel: 'escalation', reminderCount: 1 }, settings, new Date(2026, 10, 4)), ['email']);
  assert.deepEqual(resolveNotificationChannels({ notificationChannel: 'escalation', reminderCount: 2 }, settings, new Date(2026, 10, 4)), ['whatsapp']);
  assert.deepEqual(resolveNotificationChannels({ notificationChannel: 'escalation', reminderCount: 0 }, settings, new Date(2026, 10, 6)), ['whatsapp']);
});

test('WhatsApp payloads include the business, only missing items, and secure portal link', () => {
  const client = { id: 'client-1', name: 'Client', businessName: 'Example Co', whatsappPhone: '+91 98765 43210' };
  const missingItems = ['Bank Statement'];
  const uploadUrl = 'https://practice.example/upload/secure-token';
  const webhook = buildWhatsAppWebhookPayload(client, missingItems, uploadUrl);
  const meta = buildMetaTemplatePayload(client, missingItems, uploadUrl, {
    phoneNumberId: '123456789', accessToken: 'test-token', templateName: 'document_reminder'
  });

  assert.equal(webhook.to, '919876543210');
  assert.equal(webhook.client.businessName, 'Example Co');
  assert.deepEqual(webhook.missingDocuments, ['Bank Statement']);
  assert.equal(webhook.uploadUrl, uploadUrl);
  assert.equal(meta.body.to, '919876543210');
  assert.equal(meta.body.template.components[0].parameters[1].text, 'Bank Statement');
  assert.equal(meta.body.template.components[0].parameters[2].text, uploadUrl);
  assert.throws(() => buildMetaTemplatePayload({ ...client, whatsappPhone: '555' }, missingItems, uploadUrl, {
    phoneNumberId: '123456789', accessToken: 'test-token'
  }), /country code/);
});

test('practice settings responses redact WhatsApp access tokens', () => {
  const publicSettings = sanitizePracticeSettings({
    auth: { firmPassword: 'private' },
    whatsapp: { phoneNumberId: '123', accessToken: 'secret-token', webhookUrl: 'https://example.test/hook' }
  });

  assert.equal(publicSettings.whatsapp.phoneNumberId, '123');
  assert.equal(publicSettings.whatsapp.accessTokenConfigured, true);
  assert.equal(Object.hasOwn(publicSettings.whatsapp, 'accessToken'), false);
  assert.equal(Object.hasOwn(publicSettings, 'auth'), false);
});

test('reminder email includes only the supplied missing checklist items and escapes HTML', () => {
  const message = buildReminderEmail(
    { name: '<Client>', businessName: 'North & Co', email: 'client@example.com' },
    ['Bank Statement'],
    'https://practice.example/upload/client-1'
  );

  assert.match(message.subject, /North & Co/);
  assert.match(message.html, /Bank Statement/);
  assert.doesNotMatch(message.html, /Sales Register|Purchase Invoices/);
  assert.match(message.html, /&lt;Client&gt;/);
  assert.match(message.text, /https:\/\/practice\.example\/upload\/client-1/);
});

test('reminder email defaults to the requested CA sender identity', () => {
  const previousFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_FROM = '';
  try {
    const message = buildReminderEmail(
      { name: 'Client', businessName: 'Example Co', email: 'client@example.com' },
      ['Bank Statement'],
      'https://practice.example/upload/token'
    );
    assert.equal(message.from, '"CA Varun Kumar" <varun181105@gmail.com>');
  } finally {
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
  }
});

test('workspace authorization requires a verified email on the active tenant allowlist', async () => {
  const authorizedClient = {
    auth: { getUser: async () => ({ data: { user: { id: 'auth-user-1', email: 'CA@example.com', email_confirmed_at: '2026-01-01' } }, error: null }) },
    from: table => ({
      select: () => ({
        eq: (field, value) => ({
          eq: (nextField, nextValue) => ({
            maybeSingle: async () => table === 'authorized_tenants' && field === 'email' && value === 'ca@example.com' && nextField === 'is_active' && nextValue
              ? { data: { email: 'ca@example.com', practice_name: 'Example Practice' }, error: null }
              : { data: null, error: null }
          })
        })
      })
    })
  };

  const identity = await authorizeWorkspaceUser(authorizedClient, 'valid-token');
  assert.deepEqual(identity, { caId: 'auth-user-1', email: 'ca@example.com', practiceName: 'Example Practice' });

  await assert.rejects(
    authorizeWorkspaceUser({ auth: authorizedClient.auth, from: authorizedClient.from }, ''),
    error => error.status === 401
  );
  await assert.rejects(
    authorizeWorkspaceUser({
      ...authorizedClient,
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) })
    }, 'valid-token'),
    error => error.status === 403
  );
});

test('production requires workspace OAuth even without a configured Supabase URL', () => {
  assert.equal(isWorkspaceOAuthRequired('', 'production'), true);
  assert.equal(isWorkspaceOAuthRequired('https://example.supabase.co', 'development'), true);
  assert.equal(isWorkspaceOAuthRequired('', 'development'), false);
});

test('public portal lookup accepts the capability token but not the internal client ID', () => {
  const clients = [{ id: 'client-1', uploadToken: 'random-portal-token' }];

  assert.equal(findClientByPortalToken(clients, 'random-portal-token'), clients[0]);
  assert.equal(findClientByPortalToken(clients, 'client-1'), undefined);
});

test('reminder client updates preserve completed and unrelated clients', () => {
  const clients = [
    { id: 'pending-1', lastReminderSent: null },
    { id: 'completed-1', status: 'Completed' },
    { id: 'pending-2', lastReminderSent: null }
  ];
  const updated = mergeClientUpdates(clients, [{ ...clients[0], lastReminderSent: '2026-11-03T09:00:00.000Z' }]);

  assert.equal(updated.length, 3);
  assert.equal(updated.find(client => client.id === 'pending-1').lastReminderSent, '2026-11-03T09:00:00.000Z');
  assert.equal(updated.find(client => client.id === 'completed-1').status, 'Completed');
});

test('storage selection supports Supabase, PostgreSQL, MongoDB, and local fallback', () => {
  const previous = {
    supabaseUrl: process.env.SUPABASE_URL,
    databaseUrl: process.env.DATABASE_URL
  };

  try {
    delete process.env.SUPABASE_URL;
    delete process.env.DATABASE_URL;
    assert.equal(getStorageType(), 'local');

    process.env.DATABASE_URL = 'postgresql://localhost/ca';
    assert.equal(getStorageType(), 'postgres');

    process.env.DATABASE_URL = 'mongodb://localhost:27017/ca';
    assert.equal(getStorageType(), 'mongodb');

    process.env.SUPABASE_URL = 'https://example.supabase.co';
    assert.equal(getStorageType(), 'supabase');
  } finally {
    if (previous.supabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previous.supabaseUrl;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
  }
});

test('document parsing reports missing API configuration without inventing results', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const result = await parseFinancialDocument({ fileName: 'statement.pdf', clientId: 'client-test' });
    assert.equal(result.status, 'not_configured');
    assert.equal(result.totalSales, undefined);
    assert.equal(result.totalTax, undefined);
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});
