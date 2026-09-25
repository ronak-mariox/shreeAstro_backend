/**
 * The careers page: open roles, and the applications they attract.
 *
 * Postings are the admin's; applications arrive from anyone on the website
 * (no account needed) and are read and moved through their statuses from the
 * panel. An application snapshots the role's title so it outlives the posting.
 */

const mongoose = require('mongoose');

const JobPosting = require('../models/JobPosting');
const JobApplication = require('../models/JobApplication');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');

const ROLE_TITLES = {
  astrologer: 'Astrologer Application',
  internship: 'Internship Program',
};

function paging({ page = 1, limit = 20 }) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  return { skip: (current - 1) * size, limit: size, page: current };
}

const escapeRegex = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `{ _id }` for an ObjectId-looking value, `{ slug }` otherwise. */
function bySlugOrId(value) {
  const text = String(value || '').trim().toLowerCase();
  return mongoose.isValidObjectId(text) ? { $or: [{ _id: text }, { slug: text }] } : { slug: text };
}

/* -------------------------------------------------------------------------- */
/* Public                                                                     */
/* -------------------------------------------------------------------------- */

async function departments() {
  const rows = await JobPosting.aggregate([
    { $match: { status: 'open' } },
    { $group: { _id: '$department', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return rows
    .filter(row => row._id)
    .map(row => ({ key: row._id, label: JobPosting.departmentLabel(row._id), count: row.count }));
}

/** GET /careers/jobs */
async function listJobs({ department, page, limit }) {
  const query = { status: 'open' };
  if (department && department !== 'all') {
    query.department = String(department).toLowerCase();
  }
  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total, groups] = await Promise.all([
    JobPosting.find(query).sort({ postedAt: -1 }).skip(skip).limit(size),
    JobPosting.countDocuments(query),
    departments(),
  ]);
  return {
    items: items.map(job => job.toPublicJSON()),
    total,
    page: current,
    limit: size,
    departments: groups,
  };
}

/** GET /careers/jobs/:slug */
async function getJob(slugOrId) {
  const job = await JobPosting.findOne({ ...bySlugOrId(slugOrId), status: 'open' });
  if (!job) {
    throw ApiError.notFound('That role is no longer open.');
  }
  return { job: job.toPublicJSON() };
}

/** POST /careers/applications */
async function apply({ jobId, kind, roleTitle, fullName, email, phone, experience, linkedin, message, resume }) {
  let job = null;
  let title = roleTitle;
  let applicationKind = kind;

  if (jobId) {
    job = await JobPosting.findOne({ ...bySlugOrId(jobId), status: 'open' });
    if (!job) {
      throw ApiError.unprocessable('Please check the form.', { jobId: 'That role is no longer open.' });
    }
    title = job.title;
    applicationKind = job.type === 'internship' ? 'internship' : 'job';
  }
  if (!title) {
    title = ROLE_TITLES[applicationKind];
  }
  if (!title) {
    throw ApiError.unprocessable('Please check the form.', { roleTitle: 'Say which role this is for.' });
  }

  const application = await JobApplication.create({
    job: job?._id ?? null,
    roleTitle: title,
    kind: applicationKind,
    fullName,
    email,
    phone,
    experience,
    linkedin,
    message,
    resume: resume
      ? {
          url: resume.url,
          key: resume.key,
          fileName: resume.fileName,
          mimeType: resume.mimeType,
          sizeBytes: resume.sizeBytes,
        }
      : undefined,
  });

  await notificationService
    .notifyAdmins({
      type: 'application',
      title: 'New application',
      body: `${fullName} applied for ${title}.`,
      action: { screen: 'application', id: String(application._id) },
    })
    .catch(() => {});

  return application;
}

/* -------------------------------------------------------------------------- */
/* Admin: postings                                                            */
/* -------------------------------------------------------------------------- */

async function adminListJobs({ status, department, search, page, limit }) {
  const query = {};
  if (status) query.status = status;
  if (department && department !== 'all') query.department = String(department).toLowerCase();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ title: pattern }, { location: pattern }, { tags: pattern }];
  }
  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total] = await Promise.all([
    JobPosting.find(query).sort({ postedAt: -1 }).skip(skip).limit(size),
    JobPosting.countDocuments(query),
  ]);
  return { items, total, page: current, limit: size };
}

async function findJob(jobId) {
  const job = mongoose.isValidObjectId(jobId) ? await JobPosting.findById(jobId) : null;
  if (!job) {
    throw ApiError.notFound('Job posting not found.');
  }
  return job;
}

async function createJob({ changes, admin }) {
  const job = new JobPosting({ ...changes, createdBy: admin._id, updatedBy: admin._id });
  await job.save();
  return job;
}

async function updateJob({ jobId, changes, admin }) {
  const job = await findJob(jobId);
  job.set({ ...changes, updatedBy: admin._id });
  await job.save();
  return job;
}

async function setJobStatus({ jobId, status, admin }) {
  const job = await findJob(jobId);
  job.status = status;
  job.updatedBy = admin._id;
  await job.save();
  return job;
}

/** Applications keep their snapshot of the title; only their link is cleared. */
async function deleteJob({ jobId }) {
  const job = await findJob(jobId);
  await JobApplication.updateMany({ job: job._id }, { $set: { job: null } });
  await job.deleteOne();
  return { deleted: true };
}

/* -------------------------------------------------------------------------- */
/* Admin: applications                                                        */
/* -------------------------------------------------------------------------- */

const JOB_POPULATE = { path: 'job', select: 'title slug' };

async function adminListApplications({ status, kind, job, search, page, limit }) {
  const query = {};
  if (status) query.status = status;
  if (kind) query.kind = kind;
  if (job && mongoose.isValidObjectId(job)) query.job = job;
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    query.$or = [
      { fullName: pattern },
      { email: pattern },
      { phone: pattern },
      { roleTitle: pattern },
      { reference: pattern },
    ];
  }
  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total] = await Promise.all([
    JobApplication.find(query).sort({ createdAt: -1 }).skip(skip).limit(size).populate(JOB_POPULATE),
    JobApplication.countDocuments(query),
  ]);
  return { items, total, page: current, limit: size };
}

async function adminGetApplication(applicationId) {
  const application = mongoose.isValidObjectId(applicationId)
    ? await JobApplication.findById(applicationId).populate(JOB_POPULATE)
    : null;
  if (!application) {
    throw ApiError.notFound('Application not found.');
  }
  return application;
}

async function adminUpdateApplication({ applicationId, status, adminNote, admin }) {
  const application = await adminGetApplication(applicationId);
  if (status !== undefined) application.status = status;
  if (adminNote !== undefined) application.adminNote = adminNote || undefined;
  application.reviewedBy = admin._id;
  await application.save();
  return application;
}

module.exports = {
  listJobs,
  getJob,
  apply,
  adminListJobs,
  createJob,
  updateJob,
  setJobStatus,
  deleteJob,
  adminListApplications,
  adminGetApplication,
  adminUpdateApplication,
  ROLE_TITLES,
};
