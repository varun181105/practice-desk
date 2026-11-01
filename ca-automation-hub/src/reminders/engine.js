const { logActivity } = require('../lib/auditLogger');
const { readClientsForReminders, readSettingsForCa, updateClientsForCa } = require('../lib/storage');
const { isEmailConfigured, sendDocumentReminder } = require('../lib/email');
const { sendWhatsAppReminder } = require('../lib/whatsapp');
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

function shouldSendScheduledReminder(client, now = new Date(), reminderSettings = {}) {
  const checklist = client.documentChecklist || [];
  const hasMissingItems = checklist.some(item => !item.submitted);
  const primaryDay = Number(reminderSettings.primaryDayOfMonth || client.dueDayOfMonth || 5);
  const intervalDays = Number(reminderSettings.intervalDays || 2);
  const eligible = client.autoRemind !== false &&
    !['submitted', 'completed'].includes(String(client.status || '').toLowerCase()) &&
    hasMissingItems && Number.isInteger(primaryDay) && primaryDay >= 1 && primaryDay <= 31 &&
    Number.isInteger(intervalDays) && intervalDays >= 1 && intervalDays <= 90 && now.getDate() >= primaryDay;
  if (!eligible) return false;

  const lastSentAt = client.lastReminderSent ? new Date(client.lastReminderSent) : null;
  if (!lastSentAt || Number.isNaN(lastSentAt.getTime())) return true;
  const dayNumber = date => Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return dayNumber(now) - dayNumber(lastSentAt) >= intervalDays;
}

function resolveNotificationChannels(client, settings, now = new Date()) {
  const reminders = settings.reminders || {};
  const preference = client.notificationChannel || reminders.defaultNotificationChannel || 'email_only';
  if (preference === 'email_only') return ['email'];
  if (preference === 'whatsapp_only') return ['whatsapp'];
  if (preference === 'both') return ['email', 'whatsapp'];
  if (preference === 'escalation') {
    const attempts = Number(client.reminderCount || 0);
    const afterReminders = Number(reminders.escalationAfterReminders || 2);
    const primaryDay = Number(reminders.primaryDayOfMonth || client.dueDayOfMonth || 5);
    const afterDays = Number(reminders.escalationAfterDays || 3);
    const daysAfterPrimary = now.getDate() >= primaryDay ? now.getDate() - primaryDay : 0;
    return attempts >= afterReminders || daysAfterPrimary >= afterDays ? ['whatsapp'] : ['email'];
  }
  return ['email'];
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
    return !options.scheduled || shouldSendScheduledReminder(client, options.now || new Date(), settings.reminders || {});
  });

  console.log(`[Reminder Engine] Scanning ${clientsToRemind.length} clients for pending requirements...`);
  const results = [];
  const updatedClientIds = new Set();

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
      const channels = [];
      const errors = [];
      const requestedChannels = resolveNotificationChannels(client, settings, options.now || new Date());

      for (const channel of requestedChannels) {
        if (channel === 'email') {
          if (!isEmailConfigured()) {
            errors.push('Email: configure EMAIL_USER and EMAIL_PASS.');
            continue;
          }
          if (!client.email) {
            errors.push('Email: client email address is missing.');
            continue;
          }
          try {
            await sendDocumentReminder(client, missingItems, uploadUrl);
            channels.push('email');
          } catch (err) {
            console.error(`[Reminder Engine] Email delivery failed for ${client.id} (${client.email}):`, err.message);
            errors.push(`Email: ${err.message}`);
          }
        } else if (channel === 'whatsapp') {
          try {
            const whatsappResult = await sendWhatsAppReminder(settings, client, missingItems, uploadUrl);
            channels.push(whatsappResult.channel);
          } catch (err) {
            console.error(`[Reminder Engine] WhatsApp delivery failed for ${client.id} (${client.whatsappPhone || 'no number'}):`, err.message);
            errors.push(`WhatsApp: ${err.message}`);
          }
        }
      }

      if (!channels.length) {
        results.push({
          clientId: client.id,
          success: false,
          error: errors.join(' ') || 'No reminder could be delivered.'
        });
        continue;
      }

      const sentAt = new Date().toISOString();
      client.lastReminderSent = sentAt;
      client.firstReminderSentAt = client.firstReminderSentAt || sentAt;
      client.reminderCount = Number(client.reminderCount || 0) + 1;
      updatedClientIds.add(client.id);
      const dispatchResult = { clientId: client.id, success: true, channels, missingItems, uploadUrl, ...(errors.length ? { warnings: errors } : {}) };
      try {
        await logActivity({
          eventType: 'REMINDER_DISPATCHED',
          caId: client.caId,
          email: client.email,
          clientId: client.id,
          clientName: client.businessName,
          details: `Reminder sent via ${channels.join(' and ')} for missing docs: ${missingItems.join(', ')}`
        });
      } catch (err) {
        console.error(`[Reminder Engine] Reminder sent but audit logging failed for ${client.id}:`, err.message);
        dispatchResult.warnings = [...(dispatchResult.warnings || []), `Audit log: ${err.message}`];
      }
      results.push(dispatchResult);
    }
  }

  await updateClientsForCa(options.caId, clients.filter(client => updatedClientIds.has(client.id)));
  return { success: true, dispatchedCount: results.filter(r => r.success).length, details: results, dueDates };
}

function triggerScheduledReminders(now = new Date()) {
  return triggerReminders({ scheduled: true, now });
}

if (require.main === module) {
  triggerReminders();
}

module.exports = { triggerReminders, triggerScheduledReminders, shouldSendScheduledReminder, resolveNotificationChannels, computeTargetDueDates };
