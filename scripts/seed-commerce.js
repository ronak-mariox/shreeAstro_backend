/**
 * Seeds the store, the pujas and the blog with the website's launch content.
 *
 *   node scripts/seed-commerce.js
 *
 * Idempotent: every row is matched by slug and updated in place, so running
 * it again refreshes copy and prices without duplicating anything (and never
 * touches stock, ratings or bookings on rows that already exist).
 *
 * Images are served from backend/uploads/seed/<slug>.jpg — copied from the
 * website's src/assets — and stored as absolute URLs, the same form every
 * other upload is stored in (see services/storage.service.js's publicUrlFor).
 * Set PUBLIC_URL in .env to the API's real origin before seeding production.
 */

const fs = require('fs');
const path = require('path');

const env = require('../config/env');
const { connectDatabase, disconnectDatabase } = require('../config/database');
const { uploadRoot } = require('../services/storage.service');
const Product = require('../models/Product');
const Puja = require('../models/Puja');
const Article = require('../models/Article');

const ORIGIN = (env.publicUrl || 'http://localhost:5000').replace(/\/$/, '');
const SEED_DIR = path.join(uploadRoot, 'seed');

/** The URL for a seed image, or null (with a warning) when the file is missing. */
function imageFor(slug) {
  const file = `${slug}.jpg`;
  if (!fs.existsSync(path.join(SEED_DIR, file))) {
    console.warn(`  (no image for ${slug} — expected uploads/seed/${file})`);
    return null;
  }
  return `${ORIGIN}/uploads/seed/${file}`;
}

/* ------------------------------------------------------------------ data */

const PRODUCTS = [
  {
    slug: '5-mukhi-rudraksha-mala', name: '5 Mukhi Rudraksha Mala', category: 'rudraksha',
    badge: 'Bestseller', price: 850, oldPrice: 1200, rating: 4.9, ratingCount: 1800, isFeatured: true,
    description: 'A 108-bead mala of genuine five-faced (Panchmukhi) rudraksha from Nepal, strung on a strong cotton thread. Ruled by Jupiter, the 5 Mukhi bead is worn for peace of mind, focus in study and work, and steady health. Energised with Shiva mantras before dispatch.',
    highlights: ['108 + 1 genuine Nepali beads, 7–8 mm', 'Lab certified for authenticity', 'Energised with Om Namah Shivaya jaap', 'Comes with a wearing guide and cloth pouch'],
  },
  {
    slug: 'pyrite-cluster-crystal', name: 'Pyrite Cluster Crystal', category: 'crystals-pyrite',
    badge: 'Wealth Stone', price: 1200, oldPrice: 1800, rating: 4.8, ratingCount: 900, isFeatured: true,
    description: 'A natural pyrite cluster, known as the stone of wealth and confidence. Keep it on your work desk or in the north corner of the home (the direction of Kuber) to draw prosperity, ward off negativity and keep your resolve strong.',
    highlights: ['Natural, untreated cluster (approx. 250–300 g)', 'Cleansed and charged before dispatch', 'Placement guide included', 'Ideal for the office desk or cash counter'],
  },
  {
    slug: 'shri-yantra-silver-plated', name: 'Shri Yantra — Silver Plated', category: 'yantra',
    badge: 'Premium', price: 2500, oldPrice: 3500, rating: 5, ratingCount: 600, isFeatured: true,
    description: 'The Shri Yantra is the most revered of all yantras — the geometric form of Goddess Lakshmi and the whole cosmos. This silver-plated, engraved yantra on a wooden base is consecrated with Shree Sukta before it reaches you, for wealth, harmony and spiritual growth in the home or workplace.',
    highlights: ['Precision-engraved, silver plated on brass', '3D Meru form on a polished base', 'Consecrated with Shree Sukta path', 'Placement and daily puja guide included'],
  },
  {
    slug: 'amethyst-raw-crystal', name: 'Amethyst Raw Crystal', category: 'crystals-pyrite',
    badge: 'Healing', price: 650, oldPrice: 950, rating: 4.7, ratingCount: 1100,
    description: 'A raw amethyst crystal in deep violet, associated with the crown chakra and the planet Saturn. Kept by the bedside it calms an anxious mind and supports restful sleep; held in meditation it sharpens intuition.',
    highlights: ['Natural raw crystal, 80–120 g', 'Calms the mind and supports sleep', 'Cleansed in moonlight before dispatch', 'Activation ritual card included'],
  },
  {
    slug: '7-chakra-healing-bracelet', name: '7 Chakra Healing Bracelet', category: 'bracelets',
    badge: 'Popular', price: 450, oldPrice: 750, rating: 4.8, ratingCount: 2300, isFeatured: true,
    description: 'Seven natural gemstone beads — one for each chakra from root to crown — on a stretch cord that fits every wrist. Worn daily it helps balance energy, ease stress and keep the body and mind in tune.',
    highlights: ['Genuine 8 mm gemstone beads', 'Stretch cord, one size fits all', 'Energised before dispatch', 'Chakra guide card included'],
  },
  {
    slug: 'deluxe-puja-kit', name: 'Deluxe Puja Kit', category: 'puja-kits',
    badge: 'Complete Set', price: 1800, oldPrice: 2500, rating: 4.9, ratingCount: 800,
    description: 'Everything a home puja needs in one box — brass diya and kalash, roli, chandan, akshat, kalava, camphor, ghee wicks, dhoop, incense and a printed vidhi for the most common pujas. Ideal for Griha Pravesh, Satyanarayan Katha and festival days.',
    highlights: ['40+ items, all sourced fresh', 'Brass diya, kalash and puja thali', 'Printed vidhi for 12 common pujas', 'Gift-ready packaging'],
  },
  {
    slug: 'sandalwood-incense-sticks', name: 'Sandalwood Incense Sticks', category: 'incense',
    badge: 'Natural', price: 299, oldPrice: 450, rating: 4.7, ratingCount: 3400,
    description: 'Hand-rolled Mysore sandalwood incense made with natural resins and essential oil, free of charcoal and synthetic fragrance. A slow, even burn fills the room with a soft, meditative aroma for puja, meditation or simply a calm evening.',
    highlights: ['100% natural, charcoal-free', 'Hand rolled, 45-minute burn', 'Pack of 100 sticks with holder', 'Low smoke, no headache'],
  },
  {
    slug: 'tulsi-mala-108-beads', name: 'Tulsi Mala — 108 Beads', category: 'malas',
    badge: 'Sacred', price: 350, oldPrice: 550, rating: 4.9, ratingCount: 1600,
    description: 'A 108-bead japa mala of genuine tulsi wood from Vrindavan, sacred to Lord Vishnu and Krishna. Worn or used for chanting, tulsi purifies the mind, protects the wearer and is said to bring the blessings of Lakshmi Narayan.',
    highlights: ['Genuine Vrindavan tulsi wood', '108 + 1 beads, 6 mm', 'Hand knotted with sumeru bead', 'Cotton japa bag included'],
  },
  {
    slug: 'rose-quartz-crystal-set', name: 'Rose Quartz Crystal Set', category: 'crystals-pyrite',
    badge: 'Love Stone', price: 750, oldPrice: 1100, rating: 4.8, ratingCount: 900,
    description: 'A set of tumbled rose quartz stones and a heart-shaped worry stone, the crystal of unconditional love and emotional healing. Keep it in the south-west corner of the bedroom (the direction of relationships) to nurture harmony and self-love.',
    highlights: ['5 tumbled stones + 1 heart stone', 'Natural, untreated Madagascar quartz', 'Cleansed and charged before dispatch', 'Vastu placement guide included'],
  },
  {
    slug: 'spiritual-gift-box', name: 'Spiritual Gift Box', category: 'spiritual-gifts',
    badge: 'Gift Ready', price: 1499, oldPrice: 2200, rating: 4.9, ratingCount: 400,
    description: 'A curated gift box for a housewarming, birthday or festival — a rudraksha bracelet, a small brass diya, a pack of sandalwood incense, a tulsi mala and a pocket Hanuman Chalisa, presented in a hand-finished wooden box with a blessing card.',
    highlights: ['Five hand-picked spiritual items', 'Presented in a wooden keepsake box', 'Personalised blessing card on request', 'Ships gift-wrapped'],
  },
];

const PUJAS = [
  {
    slug: 'rudrabhishek-puja', name: 'Rudrabhishek', tagline: 'Supreme Shiva Worship for Divine Grace',
    category: 'shiva', categoryLabel: 'Shiva Puja', badge: 'Most Powerful', deity: 'Lord Shiva',
    price: 4999, oldPrice: 7999, rating: 4.9, ratingCount: 428, durationText: '5 hours',
    panditName: 'Pt. Shivkumar Joshi', isFeatured: true,
    description: 'Rudrabhishek is the sacred bathing of the Shiva Linga with panchamrit, water, honey and sacred herbs while the Rudra Sukta from the Yajurveda is chanted. Performed by experienced pandits, this puja removes obstacles, cleanses negative karma and invokes the boundless grace of Lord Shiva for peace and prosperity.',
    benefits: ['Removal of obstacles and negative energies', 'Peace, prosperity and spiritual growth', 'Relief from Rudra and Kaal Sarp doshas', 'Divine blessings of Lord Shiva for the whole family'],
  },
  {
    slug: 'maha-mrityunjaya-jaap', name: 'Maha Mrityunjaya Jaap', tagline: 'For Health, Longevity & Victory Over Death',
    category: 'health', categoryLabel: 'Health & Protection', badge: 'Healing', deity: 'Lord Shiva',
    price: 5499, oldPrice: 8999, rating: 4.9, ratingCount: 312, durationText: '6 hours',
    panditName: 'Pt. Ramakrishna Shastri', isFeatured: true,
    description: "The Maha Mrityunjaya Mantra is the most potent life-giving mantra in the Vedas. This puja involves 1,25,000 chantings of the mantra by experienced pandits to invoke Lord Shiva's healing grace and protection against untimely death.",
    benefits: ['Protection from untimely death', 'Healing of chronic diseases', 'Freedom from fear and anxiety', 'Divine blessings of long and healthy life'],
  },
  {
    slug: 'satyanarayan-katha', name: 'Satyanarayan Katha', tagline: 'For Family Prosperity & Auspicious Occasions',
    category: 'prosperity', categoryLabel: 'Prosperity', badge: 'Popular', deity: 'Lord Vishnu',
    price: 2199, oldPrice: 3499, rating: 4.8, ratingCount: 534, durationText: '3 hours',
    panditName: 'Pt. Ramesh Dwivedi', isFeatured: true,
    description: 'Satyanarayan Katha is a devotional worship of Lord Vishnu in his Satyanarayan form, performed on full-moon days and auspicious occasions such as housewarmings, weddings and new ventures. The five-chapter katha, sankalp, havan and prasad distribution bring harmony, fulfilment of wishes and well-being to the family.',
    benefits: ['Fulfilment of sincere wishes and goals', 'Harmony and happiness within the family', 'Success in new ventures and occasions', 'Blessings of Lord Vishnu for prosperity'],
  },
  {
    slug: 'griha-pravesh-puja', name: 'Griha Pravesh Puja', tagline: 'Sacred Housewarming for a Blessed New Home',
    category: 'home-vastu', categoryLabel: 'Home & Vastu', badge: 'New Home', deity: 'Vastu Purush',
    price: 3499, oldPrice: 5499, rating: 4.8, ratingCount: 289, durationText: '4 hours',
    panditName: 'Pt. Vijay Kumar Shastri',
    description: 'Griha Pravesh is the Vedic housewarming ceremony performed before a family steps into a new home. Through Vastu Shanti, Ganesh puja, Navgraha havan and kalash sthapana, the pandit purifies the space, pacifies Vastu doshas and invites the blessings of the deities for a lifetime of health, happiness and abundance.',
    benefits: ['Purification of the new home and its energies', 'Pacification of Vastu doshas', 'Protection from negative influences', 'Peace, prosperity and harmony for the household'],
  },
  {
    slug: 'navgraha-puja', name: 'Navgraha Puja', tagline: 'For Planetary Peace & Life Balance',
    category: 'planetary', categoryLabel: 'Planetary Healing', badge: null, deity: 'The Nine Planets',
    price: 2799, oldPrice: 4599, rating: 4.7, ratingCount: 198, durationText: '3.5 hours',
    panditName: 'Pt. Narayan Prasad',
    description: 'Navgraha Puja pacifies the nine planets — Surya, Chandra, Mangal, Budh, Guru, Shukra, Shani, Rahu and Ketu — whose positions shape every aspect of life. With individual mantras, samidha offerings and a Navgraha havan, this puja reduces the malefic effects of afflicted planets and strengthens their benefic influence.',
    benefits: ['Relief from malefic planetary effects', 'Reduced impact of Sade Sati and Mangal dosha', 'Balance in career, health and relationships', 'Strengthened benefic influence of the planets'],
  },
  {
    slug: 'personalised-puja-services', name: 'Personalised Puja Services', tagline: 'Custom Vedic Rituals for Your Specific Need',
    category: 'custom', categoryLabel: 'Custom', badge: 'Custom', deity: null,
    price: 1999, oldPrice: null, rating: 4.9, ratingCount: 156, durationText: '2–6 hours',
    panditName: 'Senior Pandit (Assigned)',
    description: 'Every life situation calls for its own remedy. Share your concern — a health worry, a career milestone, a dosha in your kundli or a family occasion — and our senior pandits design a custom Vedic ritual for you. The puja is performed live in your name and gotra, with a sankalp tailored to your intention.',
    benefits: ['Ritual designed around your specific intention', 'Performed in your name and gotra with a personal sankalp', 'Guidance from a senior pandit before and after the puja', 'Live participation from anywhere in the world'],
  },
];

/** Plain-text body, the way the admin editor writes it: blank-line paragraphs, `## ` headings. */
const html = blocks =>
  blocks.map(([tag, text]) => (tag === 'p' ? text : `## ${text}`)).join('\n\n');

const ARTICLES = [
  {
    slug: 'mercury-retrograde-august-2026',
    title: 'Mercury Retrograde August 2026: What Every Zodiac Sign Needs to Know',
    category: 'Astrology Tips', tags: ['Astrology'], author: 'Pandit Ramesh Sharma', publishedAt: '2026-08-18',
    excerpt: 'Mercury retrograde is one of the most talked-about astrological events of the year. But what does it actually mean for your sign? Discover practical tips to navigate this period with grace and clarity.',
    body: html([
      ['p', 'Three times a year Mercury appears to move backwards across the sky, and for a few weeks communication, travel and technology seem to wobble. August 2026 brings one of the most talked-about retrogrades of the year, and every zodiac sign feels it a little differently.'],
      ['h3', 'What Retrograde Really Means'],
      ['p', 'Retrograde is an optical effect created by the relative orbits of Earth and Mercury. In Vedic astrology it is read as a period when the planet of intellect turns inward, asking us to review and refine rather than launch and expand.'],
      ['p', 'Double-check contracts, back up important files and give conversations a little extra patience. Old friends and unfinished projects tend to resurface, which is an opportunity to bring them to a proper close.'],
      ['h3', 'Sign by Sign'],
      ['p', 'Fire signs may feel restless, earth signs benefit from careful planning, air signs should slow their speech and water signs are asked to revisit old emotional patterns. A personal reading reveals exactly which house of your chart this transit activates.'],
    ]),
  },
  {
    slug: 'vastu-shastra-home-office',
    title: 'Vastu Shastra for Your Home Office: 7 Simple Changes for Success',
    category: 'Vastu Tips', tags: ['Vastu'], author: 'Dr. Rajesh Joshi', publishedAt: '2026-08-16',
    excerpt: "Your home office's Vastu directly impacts your productivity, career growth, and financial stability. These seven simple changes align your workspace with the natural flow of energy.",
    body: html([
      ['p', 'Vastu Shastra treats your workspace as a living system of energy. Small adjustments to direction, placement and clutter can noticeably change how focused and productive you feel through the day.'],
      ['h3', 'Direction and Placement'],
      ['p', 'Place your desk so that you face north or east while working. Keep the south-west corner of the room heavier with cabinets or bookshelves, and leave the north-east corner light, open and clean.'],
      ['p', 'Avoid sitting with your back to a door or window, and never work beneath an overhead beam. A solid wall behind your chair gives the feeling of support that Vastu associates with steady career growth.'],
      ['p', 'Finish with a green plant in the east, a small water feature in the north and warm lighting that removes dark corners. These changes cost little and are felt within days.'],
    ]),
  },
  {
    slug: 'daily-horoscope-august-19-2026',
    title: 'Your Daily Horoscope — August 19, 2026: Planetary Alignments & Guidance',
    category: 'Daily Horoscope', tags: ['Today'], author: 'Acharya Priya Devi', publishedAt: '2026-08-19',
    excerpt: "Today's planetary alignment creates powerful opportunities for personal growth and meaningful connections. Read what the stars have in store for your zodiac sign today.",
    body: html([
      ['p', "Today's planetary alignment creates powerful opportunities for personal growth and meaningful connections. Read what the stars have in store for your zodiac sign today."],
      ['p', "The cosmic energies at play during this period bring both challenges and extraordinary opportunities for growth. Understanding the planetary influences helps us navigate life's transitions with greater awareness and intentionality."],
      ['h3', 'Key Insights'],
      ['p', 'When we align our actions with celestial rhythms, we move in harmony with the universe rather than against it. Ancient Vedic sages understood this profound truth and encoded it in the sacred science of Jyotish — the science of light.'],
      ['p', "The planetary positions at the time of your birth form a unique blueprint of your soul's purpose and karmic lessons. Learning to read and work with this blueprint is the essence of astrological wisdom."],
      ['h3', 'Practical Guidance'],
      ['p', 'For those navigating this period, focus on inner reflection rather than external action. Mercury retrograde — or any challenging transit — is an invitation to slow down, revisit, and reconsider. What needs to be re-evaluated in your life?'],
      ['p', 'Remember: the stars incline, they do not compel. Your free will, combined with astrological insight, creates the most powerful foundation for conscious living.'],
    ]),
  },
  {
    slug: 'life-path-number-7',
    title: 'Life Path Number 7: The Complete Guide to Your Numerology Destiny',
    category: 'Numerology', tags: ['Numerology'], author: 'Guruji S. Agarwal', publishedAt: '2026-08-14',
    excerpt: 'Life Path 7 is the number of the seeker, the thinker, the searcher of truth. Discover the strengths, challenges and soul purpose hidden inside this deeply spiritual number.',
    body: html([
      ['p', 'Your Life Path number is calculated from your full date of birth and describes the central lesson of this lifetime. Number 7 belongs to the seeker: analytical, introspective and drawn to the mysteries beneath the surface of things.'],
      ['h3', 'Strengths of the 7'],
      ['p', 'Sevens are natural researchers and spiritual students. They value quiet, depth and honesty, and they rarely accept an answer until they have tested it for themselves.'],
      ['p', 'The shadow side is isolation. A 7 can retreat so far into thought that relationships suffer. Balancing solitude with trusted companionship is the lifelong work of this number.'],
      ['p', 'Careers in science, teaching, astrology, writing and healing suit the 7, as does any path that rewards patience and perception over speed.'],
    ]),
  },
  {
    slug: 'amethyst-crystal-benefits',
    title: 'Amethyst Crystal: Benefits, Uses, and How to Activate It',
    category: 'Gemstone Guide', tags: ['Gemstone'], author: 'Pandit Ramesh Sharma', publishedAt: '2026-08-12',
    excerpt: 'Amethyst is one of the most powerful and popular healing crystals. Learn about its spiritual benefits, everyday uses and the simple ritual that activates its energy.',
    body: html([
      ['p', 'Amethyst is a violet variety of quartz that has been prized since ancient times for calming the mind and protecting the spirit. In Vedic gemology it is linked with Saturn and with the crown chakra.'],
      ['h3', 'Everyday Uses'],
      ['p', 'Keep a cluster near your bed to support restful sleep, wear it as a pendant during meditation, or place a tumbled stone on your desk to soften stress during long working hours.'],
      ['p', 'To activate a new amethyst, rinse it in clean water, leave it in moonlight overnight and hold it while setting a clear intention. Cleanse it every few weeks so that its energy stays bright.'],
    ]),
  },
  {
    slug: 'ganesh-chaturthi-2026',
    title: 'Ganesh Chaturthi 2026: Puja Vidhi, Muhurat & Spiritual Significance',
    category: 'Festival Articles', tags: ['Festival'], author: 'Dr. Rajesh Joshi', publishedAt: '2026-08-10',
    excerpt: 'Ganesh Chaturthi 2026 falls on September 8. Get the complete guide to celebrating this auspicious festival, from the correct muhurat to the step-by-step puja vidhi at home.',
    body: html([
      ['p', 'Ganesh Chaturthi celebrates the birth of Lord Ganesha, remover of obstacles and lord of new beginnings. In 2026 the festival begins on September 8 and continues for ten days until Anant Chaturdashi.'],
      ['h3', 'Puja Vidhi at Home'],
      ['p', 'Install the idol during the madhyahna muhurat, offer durva grass, modak and red flowers, and chant the Ganesh Atharvashirsha. Keep a ghee lamp burning through the aarti each morning and evening.'],
      ['p', 'The visarjan on the final day symbolises the cycle of creation and dissolution. Choose an eco-friendly clay idol so that the ritual honours both tradition and the earth.'],
    ]),
  },
  {
    slug: 'recurring-dream-about-water',
    title: "Recurring Dream About Water? Here's What It Means",
    category: 'Dream Interpretation', tags: ['Dreams'], author: 'Acharya Priya Devi', publishedAt: '2026-08-08',
    excerpt: 'Water in dreams carries profound spiritual meaning. Whether you are swimming, drowning, or watching a calm sea, each image carries a message from your subconscious.',
    body: html([
      ['p', 'Water is the oldest symbol of emotion and the unconscious. When it keeps returning in your dreams, the mind is asking you to pay attention to a feeling you have not fully acknowledged.'],
      ['h3', 'Reading the Image'],
      ['p', 'Calm, clear water suggests emotional balance and clarity. Rough or muddy water points to confusion or suppressed anger. Drowning often appears during periods of overwhelm, while swimming with ease reflects growing confidence.'],
      ['p', 'Note the time of the dream and the phase of the Moon. In Vedic tradition the Moon governs both water and the mind, and its transits can explain why a dream returns on particular nights.'],
    ]),
  },
  {
    slug: 'saturn-return-at-29',
    title: 'Saturn Return at 29: The Cosmic Initiation That Changes Everything',
    category: 'Astrology Tips', tags: ['Astrology'], author: 'Guruji S. Agarwal', publishedAt: '2026-08-06',
    excerpt: 'Around age 29, Saturn returns to its natal position for the first time. This cosmic rite of passage tests your foundations and asks you to build a life that is truly your own.',
    body: html([
      ['p', 'Saturn takes roughly 29.5 years to travel once around the zodiac. When it returns to the exact position it held at your birth, it marks the true threshold of adulthood in astrological terms.'],
      ['h3', 'What to Expect'],
      ['p', 'Structures that were built on borrowed values tend to fall away: careers, relationships and beliefs that never really belonged to you. What remains is stronger, and what you build next carries your own signature.'],
      ['p', 'Discipline, patience and honest self-assessment are Saturn’s gifts. Treat this period as an initiation rather than a punishment and it becomes one of the most rewarding chapters of your life.'],
      ['p', 'A birth-chart reading shows which house Saturn occupies and therefore which area of life the return will reshape most deeply.'],
    ]),
  },
];

/* ------------------------------------------------------------------ run */

/**
 * Finds by slug and saves through the document, so the models' hooks run
 * (slug normalisation, readMinutes). `onCreate` holds the fields a re-run must
 * not overwrite — stock and ratings are live data once the store is open.
 */
async function upsert(Model, slug, values, onCreate = {}) {
  const existing = await Model.findOne({ slug });
  if (existing) {
    existing.set(values);
    await existing.save();
    return 'updated';
  }
  await new Model({ slug, ...values, ...onCreate }).save();
  return 'created';
}

async function run() {
  await connectDatabase();
  const counts = { created: 0, updated: 0 };
  const tally = outcome => { counts[outcome] += 1; };

  console.log(`Seeding with images at ${ORIGIN}/uploads/seed/…`);

  for (const { slug, rating, ratingCount, ...product } of PRODUCTS) {
    const imageUrl = imageFor(slug);
    tally(await upsert(
      Product,
      slug,
      { ...product, status: 'active', ...(imageUrl ? { imageUrl, images: [imageUrl] } : {}) },
      { stock: 25, rating, ratingCount },
    ));
  }

  for (const { slug, rating, ratingCount, ...puja } of PUJAS) {
    const imageUrl = imageFor(slug);
    tally(await upsert(
      Puja,
      slug,
      { ...puja, status: 'active', ...(imageUrl ? { imageUrl } : {}) },
      { rating, ratingCount },
    ));
  }

  for (const { slug, publishedAt, ...article } of ARTICLES) {
    const coverImageUrl = imageFor(slug);
    tally(await upsert(
      Article,
      slug,
      {
        ...article,
        status: 'published',
        visibility: 'everyone',
        publishedAt: new Date(`${publishedAt}T09:00:00+05:30`),
        ...(coverImageUrl ? { coverImageUrl } : {}),
      },
    ));
  }

  console.log(
    `Done. ${counts.created} created, ${counts.updated} updated ` +
    `(${PRODUCTS.length} products, ${PUJAS.length} pujas, ${ARTICLES.length} articles).`,
  );
  await disconnectDatabase();
}

run().catch(async error => {
  console.error('Could not seed the store:', error.message);
  process.exit(1);
});
