const axios = require('axios');
const { logActivity } = require('../lib/auditLogger');
const { readState, writeState, readClientsForReminders, readSettingsForCa, writeClientsForCa } = require('../lib/storage');
const { isEmailConfigured, sendDocumentReminder } = require('../lib/email');
require('dotenv').config();

function computeTargetDueDates(settings) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  return (settings.statutoryCalendar || []).map(item => {
    let dueDate = new Date();

    if (item.frequency === 'monthly') {
      dueDate = new Date(year, month, item.dueDay);
      if (now > dueDate) {
        dueDate = new Date(year, month + 1, item.dueDay);
      }
    } else if (item.frequency === 'yearly') {
      const targetMonth = item.dueMonth - 1;
      dueDate = new Date(year, targetMonth, item.dueDay);
      if (now > dueDate) {
        dueDate = new Date(year + 1, targetMonth, item.dueDay);
      }
    }

    const diffDays = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
    let alertLevel = 'Standard Nudge';

    if (diffDays <= 1) alertLevel = 'Final Alert';
    else if (diffDays <= 3) alertLevel = 'Standard Nudge';
    else if (diffDays <= 7) alertLevel = 'Early Nudge';

    return {
      id: item.id,
      label: item.label,
      dueDate: dueDate.toISOString().split('T')[0],
      daysRemaining: diffDays,
      alertLevel
    };
  });
}

function shouldSendScheduledReminder(client, now = new Date()) {
  const checklist = client.documentChecklist || [];
  const hasMissingItems = checklist.some(item => !item.submitted);
  const dueDay = Number(client.dueDayOfMonth || 5);
  return client.autoRemind !== false &&
    !['submitted', 'completed'].includes(String(client.status || '').toLowerCase()) &&
    hasMissingItems && Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31 && now.getDate() >= dueDay;
}

async function triggerReminders(options = {}) {
  const clients = await readClientsForReminders(options.caId);
  if (options.scheduled && !options.caId && process.env.SUPABASE_URL) {
    const tenantIds = [...new Set(clients.map(client => client.caId).filter(Boolean))];
    const tenantResults = [];
    for (const caId of tenantIds) {
      tenantResults.push(await triggerReminders({ ...options, caId }));
    }
    return {
      success: true,
      dispatchedCount: tenantResults.reduce((total, result) => total + result.dispatchedCount, 0),
      details: tenantResults.flatMap(result => result.details),
      dueDates: tenantResults.flatMap(result => result.dueDates)
    };
  }
  const settings = await readSettingsForCa(options.caId);
  const baseUrl = process.env.PUBLIC_PORTAL_URL || settings.baseUrl || 'http://localhost:3000';
  const dueDates = computeTargetDueDates(settings);
  if (options.scheduled && settings.reminders?.autoRemindersEnabled === false) {
    return { success: true, dispatchedCount: 0, details: [], dueDates };
  }
  const clientsToRemind = clients.filter(client => {
    if (options.caId && client.caId !== options.caId) return false;
    return !options.scheduled || shouldSendScheduledReminder(client, options.now || new Date());
  });

  console.log(`[Reminder Engine] Scanning ${clientsToRemind.length} clients for pending requirements...`);
  const results = [];

  for (const client of clientsToRemind) {
    const missingItems = (client.documentChecklist || [])
      .filter(item => !item.submitted)
      .map(item => item.title || item.label || item.id);

    if (missingItems.length > 0) {
      let portalBase;
      try {
        portalBase = new URL(baseUrl);
      } catch (err) {
        results.push({ clientId: client.id, success: false, error: 'Public portal URL is invalid.' });
        continue;
      }
      if (!['http:', 'https:'].includes(portalBase.protocol)) {
        results.push({ clientId: client.id, success: false, error: 'Public portal URL must use HTTP or HTTPS.' });
        continue;
      }
      const uploadUrl = new URL(`/upload/${encodeURIComponent(client.uploadToken)}`, portalBase).toString();
      const webhookConfigured = settings.n8n && settings.n8n.webhookUrl && /^https?:\/\//i.test(settings.n8n.webhookUrl);
      const payload = {
        type: 'DOCUMENT_REMINDER',
        clientId: client.id,
        caId: client.caId || null,
        client: {
          id: client.id,
          name: client.name,
          businessName: client.businessName,
          email: client.email,
          phone: client.phone
        },
        missingDocuments: missingItems,
        uploadUrl,
        dueDates,
        timestamp: new Date().toISOString()
      };

      const channels = [];
      const errors = [];

      if (isEmailConfigured()) {
        if (!client.email) {
          errors.push('Client email address is missing.');
        } else {
          try {
            await sendDocumentReminder(client, missingItems, uploadUrl);
            channels.push('email');
          } catch (err) {
            errors.push(`Email: ${err.message}`);
          }
        }
      }

      if (webhookConfigured) {
        try {
          await axios.post(settings.n8n.webhookUrl, payload, { timeout: 10000 });
          channels.push('n8n');
        } catch (err) {
          errors.push(`n8n: ${err.message}`);
        }
      }

      if (!channels.length) {
        const noChannelConfigured = !isEmailConfigured() && !webhookConfigured;
        results.push({
          clientId: client.id,
          success: false,
          error: errors.join(' ') || (noChannelConfigured
            ? 'Configure email credentials or an n8n reminder webhook.'
            : 'No reminder could be delivered.')
        });
        continue;
      }

      client.lastReminderSent = new Date().toISOString();
      results.push({ clientId: client.id, success: true, channels, missingItems, uploadUrl, ...(errors.length ? { warnings: errors } : {}) });
      await logActivity({
        eventType: 'REMINDER_DISPATCHED',
        caId: client.caId,
        email: client.email,
        clientId: client.id,
        clientName: client.businessName,
        details: `Reminder sent via ${channels.join(' and ')} for missing docs: ${missingItems.join(', ')}`
      });
    }
  }

  await writeClientsForCa(options.caId, clients);
  return { success: true, dispatchedCount: results.filter(r => r.success).length, details: results, dueDates };
}

function triggerScheduledReminders(now = new Date()) {
  return triggerReminders({ scheduled: true, now });
}

if (require.main === module) {
  triggerReminders();
}

module.exports = { triggerReminders, triggerScheduledReminders, shouldSendScheduledReminder, computeTargetDueDates };
