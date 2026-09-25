/**
 * Someone applying — for a posted role, to join as an astrologer, or for the
 * internship programme.
 *
 * Public, unauthenticated, rate-limited (routes/growth.routes.js). The role
 * title is copied in at submission so the row still reads correctly if the
 * posting is later closed or deleted. The resume is a whole file record, like
 * an astrologer's documents, so the admin sees its name, type and size.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const { randomCode } = require('./Order');

const KINDS = ['job', 'astrologer', 'internship'];
const STATUSES = ['received', 'shortlisted', 'interview', 'rejected', 'hired'];

const jobApplicationSchema = new Schema(
  {
    reference: { type: String, unique: true, index: true, default: () => `APP-${randomCode()}` },
    job: { type: Schema.Types.ObjectId, ref: 'JobPosting', default: null, index: true },
    roleTitle: { type: String, trim: true, required: true, maxlength: 120 },
    kind: { type: String, enum: KINDS, required: true, index: true },

    fullName: { type: String, trim: true, required: true, maxlength: 80 },
    email: { type: String, trim: true, lowercase: true, required: true },
    phone: { type: String, trim: true, required: true },
    experience: { type: String, trim: true, maxlength: 120 },
    linkedin: { type: String, trim: true, maxlength: 300 },
    message: { type: String, trim: true, maxlength: 3000 },

    resume: {
      url: { type: String, trim: true },
      key: { type: String, trim: true },
      fileName: { type: String, trim: true },
      mimeType: { type: String, trim: true },
      sizeBytes: { type: Number, min: 0 },
    },

    status: { type: String, enum: STATUSES, default: 'received', index: true },
    adminNote: { type: String, trim: true, maxlength: 1000 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        if (ret.job && typeof ret.job === 'object') {
          ret.job = { id: String(ret.job._id ?? ret.job.id), title: ret.job.title, slug: ret.job.slug };
        } else if (ret.job) {
          ret.job = String(ret.job);
        }
        if (ret.resume && !ret.resume.url) {
          ret.resume = null;
        }
        return ret;
      },
    },
  },
);

jobApplicationSchema.index({ status: 1, createdAt: -1 });
jobApplicationSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.JobApplication || mongoose.model('JobApplication', jobApplicationSchema);
module.exports.KINDS = KINDS;
module.exports.STATUSES = STATUSES;
