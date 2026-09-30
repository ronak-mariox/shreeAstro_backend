/**
 * URL slugs for anything addressed by name — products, pujas, articles.
 *
 * `slugify` is the plain text-to-slug step. `applySlug` is the mongoose
 * pre-validate hook body every sluggable model shares: it builds the slug from
 * the title the first time, rebuilds it when the title changes (unless the
 * caller set a slug by hand in the same write), and appends `-2`, `-3`, … when
 * another document already owns the same slug.
 */

function slugify(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * @param doc         The mongoose document being validated (`this` in the hook).
 * @param titleField  Which field the slug is derived from.
 */
async function applySlug(doc, titleField) {
  const titleChanged = doc.isModified(titleField) && !doc.isModified('slug');
  if (doc.slug && !titleChanged) {
    /** A hand-set slug is still normalised, never trusted raw. */
    doc.slug = slugify(doc.slug) || doc.slug;
    if (!doc.isModified('slug')) {
      return;
    }
  } else if (doc[titleField]) {
    doc.slug = slugify(doc[titleField]);
  }
  if (!doc.slug) {
    return;
  }

  const Model = doc.constructor;
  const base = doc.slug;
  let candidate = base;
  for (let suffix = 2; ; suffix += 1) {
    const clash = await Model.exists({ slug: candidate, _id: { $ne: doc._id } });
    if (!clash) {
      break;
    }
    candidate = `${base}-${suffix}`;
  }
  doc.slug = candidate;
}

module.exports = { slugify, applySlug };
