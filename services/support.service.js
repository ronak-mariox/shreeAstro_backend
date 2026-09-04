/**
 * Support tickets and disputes, raised from either app.
 *
 * astro_app's Help & Support screen files these; an admin answers them from
 * the panel.
 */

const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const SupportTicket = require('../models/SupportTicket');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');

const OWNER_MODELS = { user: User, astrologer: Astrologer };

/** Files a ticket. */
async function create({ ownerRole, ownerId, issueType, description, chatSession }) {
  if (!issueType) {
    throw ApiError.badRequest('Pick the kind of issue you are reporting.', {
      issueType: 'Pick an issue type.',
    });
  }
  if (!description || String(description).trim().length < 10) {
    throw ApiError.badRequest('Describe the issue in a little more detail.', {
      description: 'At least 10 characters.',
    });
  }

  const owner = await OWNER_MODELS[ownerRole].findById(ownerId).select('name');

  const ticket = await SupportTicket.create({
    ownerRole,
    owner: ownerId,
    ownerName: owner?.name,
    issueType,
    description: String(description).trim(),
    chatSession,
  });

  await notificationService.notifyAdmins({
    type: 'system',
    title: 'New support ticket',
    body: `${owner?.name || 'Someone'} filed a ${issueType} ticket: ${ticket.reference}.`,
    action: { screen: 'support', id: String(ticket._id) },
  });

  return ticket;
}

/** The tickets one account has raised. */
async function listMine({ ownerRole, ownerId, page = 1, limit = 20 }) {
  const skip = (Math.max(Number(page), 1) - 1) * limit;
  const query = { ownerRole, owner: ownerId };

  const [items, total] = await Promise.all([
    SupportTicket.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
    SupportTicket.countDocuments(query),
  ]);

  return { items, total, page: Number(page), limit: Number(limit) };
}

/** The admin panel's queue. */
async function listAll({ status, issueType, ownerRole, page = 1, limit = 25 }) {
  const query = {};
  if (status) query.status = status;
  if (issueType) query.issueType = issueType;
  if (ownerRole) query.ownerRole = ownerRole;

  const skip = (Math.max(Number(page), 1) - 1) * limit;

  const [items, total] = await Promise.all([
    SupportTicket.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
    SupportTicket.countDocuments(query),
  ]);

  return { items, total, page: Number(page), limit: Number(limit) };
}

/** An admin answers a ticket, and whoever raised it is told. */
async function resolve({ ticketId, status, resolution, admin }) {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) {
    throw ApiError.notFound('Ticket not found.');
  }

  ticket.status = status || 'resolved';
  ticket.resolution = resolution;

  if (ticket.status === 'resolved' || ticket.status === 'closed') {
    ticket.resolvedAt = new Date();
    ticket.resolvedBy = admin._id;
  }
  await ticket.save();

  await notificationService.notify({
    ownerRole: ticket.ownerRole,
    ownerId: ticket.owner,
    type: 'system',
    title: `Your ticket ${ticket.reference} was updated`,
    body: resolution || `It is now ${ticket.status.replace('_', ' ')}.`,
  });

  return ticket;
}

module.exports = { create, listMine, listAll, resolve };
