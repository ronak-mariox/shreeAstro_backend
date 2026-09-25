/**
 * An open role on the careers page.
 *
 * `department` is a lowercase key the page filters by ('engineering',
 * 'astrology', 'internship' …); `slug` follows the title the same way a
 * product's does (utils/slug.js). Applications keep a snapshot of the title,
 * so a posting can be closed or deleted without orphaning them.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const { applySlug } = require('../utils/slug');

const TYPES = ['full-time', 'part-time', 'contract', 'internship'];
const STATUSES = ['open', 'closed', 'draft'];
/** The departments the page knows how to label; anything else is title-cased. */
const DEPARTMENT_LABELS = {
  engineering: 'Engineering',
  design: 'Design',
  astrology: 'Astrology',
  operations: 'Operations',
  marketing: 'Marketing',
  internship: 'Internship',
};

const jobPostingSchema = new Schema(
  {
    title: { type: String, trim: true, required: true, maxlength: 120 },
    slug: { type: String, trim: true, lowercase: true, unique: true, index: true },
    department: { type: String, trim: true, lowercase: true, required: true, index: true },
    location: { type: String, trim: true, maxlength: 80 },
    type: { type: String, enum: TYPES, default: 'full-time' },
    /** Free text: '2–4 yrs', '8+ yrs'. */
    experience: { type: String, trim: true, maxlength: 40 },
    tags: [{ type: String, trim: true }],

    description: { type: String, trim: true, maxlength: 5000 },
    responsibilities: [{ type: String, trim: true }],
    requirements: [{ type: String, trim: true }],

    /** Either, as printed: '₹25,000/mo' or '₹18–24 LPA'. */
    stipend: { type: String, trim: true, maxlength: 40 },
    salary: { type: String, trim: true, maxlength: 40 },
    openings: { type: Number, default: 1, min: 1, validate: Number.isInteger },

    status: { type: String, enum: STATUSES, default: 'open', index: true },
    postedAt: { type: Date, default: Date.now },

    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        ret.departmentLabel = doc.departmentLabel;
        return ret;
      },
    },
  },
);

jobPostingSchema.index({ status: 1, department: 1, postedAt: -1 });

jobPostingSchema.virtual('departmentLabel').get(function departmentLabel() {
  return JobPostingLabel(this.department);
});

function JobPostingLabel(key) {
  if (!key) return null;
  return (
    DEPARTMENT_LABELS[key] ||
    String(key)
      .split('-')
      .filter(Boolean)
      .map(word => word[0].toUpperCase() + word.slice(1))
      .join(' ')
  );
}

jobPostingSchema.pre('validate', async function setSlug() {
  await applySlug(this, 'title');
});

/** The careers page — no audit fields, no status. */
jobPostingSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: String(this._id),
    slug: this.slug,
    title: this.title,
    department: this.department,
    departmentLabel: this.departmentLabel,
    location: this.location ?? null,
    type: this.type,
    experience: this.experience ?? null,
    tags: this.tags || [],
    description: this.description ?? null,
    responsibilities: this.responsibilities || [],
    requirements: this.requirements || [],
    stipend: this.stipend ?? null,
    salary: this.salary ?? null,
    openings: this.openings,
    postedAt: this.postedAt,
  };
};

module.exports = mongoose.models.JobPosting || mongoose.model('JobPosting', jobPostingSchema);
module.exports.TYPES = TYPES;
module.exports.STATUSES = STATUSES;
module.exports.DEPARTMENT_LABELS = DEPARTMENT_LABELS;
module.exports.departmentLabel = JobPostingLabel;
