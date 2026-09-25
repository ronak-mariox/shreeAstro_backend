/**
 * Seeds the offers page, the reviews page's testimonials and the careers page
 * with the website's launch content.
 *
 *   node scripts/seed-growth.js
 *
 * Idempotent: coupons are matched by code, festival offers by title,
 * testimonials by kind + title, job postings by slug — each is updated in
 * place, so running it again refreshes copy without duplicating anything
 * (and never touches a coupon's usedCount or a testimonial's views on rows
 * that already exist).
 *
 * Images are copied from the website's src/assets into backend/uploads/seed
 * and stored as absolute URLs, the same form every other upload is stored in
 * (see services/storage.service.js's publicUrlFor). Set PUBLIC_URL in .env to
 * the API's real origin before seeding production.
 */

const fs = require('fs');
const path = require('path');

const env = require('../config/env');
const { connectDatabase, disconnectDatabase } = require('../config/database');
const { uploadRoot } = require('../services/storage.service');
const FestivalOffer = require('../models/FestivalOffer');
const Testimonial = require('../models/Testimonial');
const JobPosting = require('../models/JobPosting');

const ORIGIN = (env.publicUrl || 'http://localhost:5000').replace(/\/$/, '');
const SEED_DIR = path.join(uploadRoot, 'seed');
const WEB_ASSETS = path.join(__dirname, '..', '..', 'shree_astroWeb', 'src', 'assets', 'pages');

/**
 * Copies one website asset into uploads/seed (when the website checkout is
 * beside the backend) and returns its public URL — or null, with a warning,
 * when neither the copy nor a previously copied file exists.
 */
function imageFor(folder, file) {
  const target = path.join(SEED_DIR, file);
  if (!fs.existsSync(target)) {
    const source = path.join(WEB_ASSETS, folder, file);
    if (fs.existsSync(source)) {
      fs.mkdirSync(SEED_DIR, { recursive: true });
      fs.copyFileSync(source, target);
    } else {
      console.warn(`  (no image ${file} — expected uploads/seed/${file} or the website's assets/pages/${folder})`);
      return null;
    }
  }
  return `${ORIGIN}/uploads/seed/${file}`;
}

const ist = text => new Date(`${text}T00:00:00+05:30`);
const endOfIst = text => new Date(`${text}T23:59:59+05:30`);

/* ------------------------------------------------------------------ data */

const FESTIVALS = [
  {
    title: 'Ganesh Chaturthi Special', subtitle: 'Get 2 consultations at the price of 1', badge: 'Limited Time',
    image: 'festival-ganesh.jpg', startsAt: ist('2026-09-01'), endsAt: endOfIst('2026-09-08'), linkTo: '/astrologers', sortOrder: 1,
  },
  {
    title: 'Navratri Puja Package', subtitle: '35% off on all Puja services', badge: 'Festive',
    image: null, startsAt: ist('2026-10-04'), endsAt: endOfIst('2026-10-13'), linkTo: '/puja', couponCode: null, sortOrder: 2,
  },
  {
    title: 'Diwali Prosperity Pack', subtitle: 'Free Laxmi Kundli + 40% store discount', badge: 'Mega Sale',
    image: null, startsAt: ist('2026-10-25'), endsAt: endOfIst('2026-11-01'), linkTo: '/store', couponCode: null, sortOrder: 3,
  },
  {
    title: 'Dussehra Victory Offer', subtitle: 'Career consultation free with Navgraha Puja', badge: 'Bundle',
    image: 'festival-dussehra.jpg', startsAt: ist('2026-10-06'), endsAt: endOfIst('2026-10-13'), linkTo: '/puja', sortOrder: 4,
  },
];

const VIDEOS = [
  { title: 'Marriage Prediction Came True', name: 'Deepika Mehta', city: 'Mumbai', duration: '2:34', views: 28400, thumbnail: 'video-marriage.jpg', tag: 'Marriage' },
  { title: 'Career Breakthrough After Consultation', name: 'Arjun Singh', city: 'Jaipur', duration: '3:12', views: 19100, thumbnail: 'video-career.jpg', tag: 'Career' },
  { title: 'Vastu Tips Transformed My Business', name: 'Lakshmi Iyer', city: 'Chennai', duration: '4:05', views: 34700, thumbnail: 'video-vastu.jpg', tag: 'Vastu' },
  { title: 'How Kundli Changed My Life Decisions', name: 'Vikram Nair', city: 'Kochi', duration: '2:58', views: 15800, thumbnail: 'video-kundli.jpg', tag: 'Kundli' },
];

const STORIES = [
  {
    title: 'From Debt to Financial Freedom', outcome: '₹12L debt → Business owner', duration: 'in 18 months',
    quote: 'After following the financial remedies and Muhurat-based business decisions recommended by Guruji, I was able to clear my debt and start a profitable venture.',
    name: 'Rajat Khanna', city: 'Delhi', avatar: 'rajat-khanna.jpg', tag: 'Career & Finance',
  },
  {
    title: 'Found My Soulmate at 34', outcome: 'Single → Happily engaged', duration: 'in 8 months',
    quote: "Acharya Priya Devi's relationship guidance and the marriage timing prediction were exact. I met my fiance exactly when she predicted. Getting married this November!",
    name: 'Ananya Sharma', city: 'Bengaluru', avatar: 'ananya-sharma.jpg', tag: 'Love & Marriage',
  },
  {
    title: 'Dream Career Became Reality', outcome: 'Stuck → Dream job', duration: 'in 6 months',
    quote: 'The career analysis identified I was in the wrong field entirely. Following the guidance on right timing and direction, I switched careers and landed my dream job in tech.',
    name: 'Suresh Menon', city: 'Mumbai', avatar: 'suresh-menon.jpg', tag: 'Career & Finance',
  },
];

const JOBS = [
  {
    slug: 'senior-backend-engineer', title: 'Senior Backend Engineer', department: 'engineering', location: 'Bangalore (Hybrid)',
    type: 'full-time', experience: '4–7 yrs', tags: ['Node.js', 'PostgreSQL', 'Redis', 'AWS'], postedAt: ist('2026-08-15'), openings: 2,
    description: 'Own the services behind consultations, payments and the kundli engine — the APIs five lakh seekers a day rely on. You will design for correctness first: money that always adds up, sessions that never double-bill, and jobs that recover from a crash without human help.',
    responsibilities: ['Design and ship backend services in Node.js', 'Own data models and migrations across MongoDB and Redis', 'Keep billing and wallet flows correct under load', 'Review code and mentor engineers on the team'],
    requirements: ['4–7 years building production backends', 'Strong grasp of transactions, idempotency and queues', 'Comfortable operating services on AWS', 'Clear written communication'],
    salary: '₹28–40 LPA',
  },
  {
    slug: 'product-designer', title: 'Product Designer', department: 'design', location: 'Remote',
    type: 'full-time', experience: '3–5 yrs', tags: ['Figma', 'User Research', 'Prototyping', 'Design Systems'], postedAt: ist('2026-08-14'),
    description: 'Shape how a seeker meets an astrologer, reads a kundli and pays for a puja — across the website, two apps and the admin console. You will run research with real seekers and astrologers and turn what you learn into flows the team can build.',
    responsibilities: ['Design end-to-end flows across web and mobile', 'Run interviews and usability sessions', 'Grow and document the design system', 'Partner with engineers through delivery'],
    requirements: ['3–5 years of product design', 'A portfolio of shipped mobile and web work', 'Fluent in Figma, prototyping and design tokens', 'Hindi is a plus'],
    salary: '₹18–26 LPA',
  },
  {
    slug: 'head-of-astrology-content', title: 'Head of Astrology Content', department: 'astrology', location: 'Bangalore',
    type: 'full-time', experience: '8+ yrs', tags: ['Vedic Astrology', 'Content Strategy', 'Team Leadership', 'Hindi/English'], postedAt: ist('2026-08-12'),
    description: 'Lead the team that writes our horoscopes, kundli reports, remedies and articles — accurate to the shastras, readable by anyone, in Hindi and English. You will set the editorial standard every astrologer on the platform is held to.',
    responsibilities: ['Own the editorial calendar and quality bar', 'Lead a team of astrologers and writers', 'Review kundli report templates and remedies', 'Represent Shree Astro at events and in the press'],
    requirements: ['8+ years practising and writing on Vedic astrology', 'Experience leading a content team', 'Bilingual Hindi and English', 'Comfortable with data on what readers actually open'],
    salary: '₹30–45 LPA',
  },
  {
    slug: 'growth-marketing-manager', title: 'Growth Marketing Manager', department: 'marketing', location: 'Remote',
    type: 'full-time', experience: '3–6 yrs', tags: ['Performance Marketing', 'Analytics', 'A/B Testing', 'SQL'], postedAt: ist('2026-08-10'),
    description: 'Bring the next million seekers to the platform, profitably. You will own paid and organic acquisition, the referral programme and the offers calendar, and measure everything down to the rupee.',
    responsibilities: ['Plan and run acquisition campaigns across channels', 'Own the referral and offers calendar', 'Run experiments and read the numbers honestly', 'Work with design on landing pages and creatives'],
    requirements: ['3–6 years in growth or performance marketing', 'Hands-on with analytics tools and SQL', 'Experience with consumer apps in India', 'Comfortable with a budget and a target'],
    salary: '₹16–24 LPA',
  },
  {
    slug: 'astrologer-support-specialist', title: 'Astrologer Support Specialist', department: 'operations', location: 'Bangalore',
    type: 'full-time', experience: '1–3 yrs', tags: ['Customer Success', 'Astrology Basics', 'Hindi', 'Excel'], postedAt: ist('2026-08-08'), openings: 3,
    description: 'Be the person our astrologers call. You will onboard new astrologers, help them with documents and payouts, resolve disputes fairly and keep the panel humming.',
    responsibilities: ['Onboard and verify new astrologers', 'Resolve seeker and astrologer tickets', 'Coordinate payouts with finance', 'Spot and escalate quality issues'],
    requirements: ['1–3 years in support or operations', 'Fluent Hindi and English', 'Organised and calm under pressure', 'Working knowledge of astrology is a plus'],
    salary: '₹5–8 LPA',
  },
  {
    slug: 'ios-engineer', title: 'iOS Engineer', department: 'engineering', location: 'Bangalore (Hybrid)',
    type: 'full-time', experience: '3–5 yrs', tags: ['Swift', 'SwiftUI', 'WebRTC', 'Core Data'], postedAt: ist('2026-08-06'),
    description: 'Build the seeker and astrologer apps for iPhone — live chat and calls, wallet, kundli charts — with the polish Apple users expect.',
    responsibilities: ['Ship features across both iOS apps', 'Own real-time chat and call experiences', 'Keep the apps fast, accessible and crash-free', 'Work closely with backend on API design'],
    requirements: ['3–5 years shipping iOS apps', 'Strong Swift and SwiftUI', 'Experience with WebRTC or live media a plus', 'Care for detail'],
    salary: '₹20–30 LPA',
  },
];

const INTERNSHIPS = [
  { slug: 'product-design-intern', title: 'Product Design Intern', experience: '6 months', stipend: '₹25,000/mo', tags: ['Figma', 'UX Research'], postedAt: ist('2026-08-05') },
  { slug: 'frontend-engineering-intern', title: 'Frontend Engineering Intern', experience: '6 months', stipend: '₹30,000/mo', tags: ['React', 'TypeScript'], postedAt: ist('2026-08-05') },
  { slug: 'astrology-research-intern', title: 'Astrology Research Intern', experience: '3 months', stipend: '₹15,000/mo', tags: ['Vedic Astrology', 'Writing'], postedAt: ist('2026-08-05') },
  { slug: 'growth-marketing-intern', title: 'Growth & Marketing Intern', experience: '3 months', stipend: '₹18,000/mo', tags: ['Analytics', 'Social Media'], postedAt: ist('2026-08-05') },
].map(internship => ({
  ...internship,
  department: 'internship',
  type: 'internship',
  location: 'Bangalore / Remote',
  description: `A ${internship.experience} paid internship on the ${internship.title.replace(' Intern', '').toLowerCase()} team, working alongside the full-time team on real product work. Strong interns are offered full-time roles.`,
  responsibilities: ['Own small, real pieces of work end to end', 'Learn from weekly reviews with your mentor', 'Present what you built to the team'],
  requirements: ['Final-year students or recent graduates', `Interest in ${internship.tags.join(' and ')}`, 'Available full time for the duration'],
}));

/* ------------------------------------------------------------------ run */

/**
 * Finds by `match` and saves through the document, so the models' hooks run
 * (slug normalisation, code uppercasing). `onCreate` holds the fields a re-run
 * must not overwrite — usage counts and views are live once the site is open.
 */
async function upsert(Model, match, values, onCreate = {}) {
  const existing = await Model.findOne(match);
  if (existing) {
    existing.set(values);
    await existing.save();
    return 'updated';
  }
  await new Model({ ...match, ...values, ...onCreate }).save();
  return 'created';
}

async function run() {
  await connectDatabase();
  const counts = { created: 0, updated: 0 };
  const tally = outcome => { counts[outcome] += 1; };

  console.log(`Seeding with images at ${ORIGIN}/uploads/seed/…`);

  /* Coupons are created by admins in the panel, never seeded. */

  for (const { image, ...offer } of FESTIVALS) {
    const imageUrl = image ? imageFor('offers', image) : null;
    tally(await upsert(
      FestivalOffer,
      { title: offer.title },
      { ...offer, status: 'active', ...(imageUrl ? { imageUrl } : {}) },
    ));
  }

  for (const { thumbnail, views, ...video } of VIDEOS) {
    const thumbnailUrl = imageFor('reviews', thumbnail);
    tally(await upsert(
      Testimonial,
      { kind: 'video', title: video.title },
      { ...video, status: 'published', sortOrder: VIDEOS.findIndex(v => v.title === video.title) + 1, ...(thumbnailUrl ? { thumbnailUrl } : {}) },
      { views },
    ));
  }

  for (const { avatar, ...story } of STORIES) {
    const avatarUrl = imageFor('reviews', avatar);
    tally(await upsert(
      Testimonial,
      { kind: 'story', title: story.title },
      { ...story, status: 'published', sortOrder: STORIES.findIndex(s => s.title === story.title) + 1, ...(avatarUrl ? { avatarUrl } : {}) },
    ));
  }

  for (const { slug, ...job } of [...JOBS, ...INTERNSHIPS]) {
    tally(await upsert(JobPosting, { slug }, { ...job, status: 'open' }));
  }

  console.log(
    `Done. ${counts.created} created, ${counts.updated} updated ` +
    `(${FESTIVALS.length} festival offers, ${VIDEOS.length + STORIES.length} testimonials, ` +
    `${JOBS.length + INTERNSHIPS.length} job postings).`,
  );
  await disconnectDatabase();
}

run().catch(async error => {
  console.error('Could not seed the growth content:', error.message);
  process.exit(1);
});
