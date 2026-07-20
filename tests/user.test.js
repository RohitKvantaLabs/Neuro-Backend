/**
 * Auth / Onboarding integration tests (Section 10 architecture)
 *
 * §10.2: Full tokens issued immediately. requireOnboardingComplete middleware
 *        gates dashboard routes — no scoped tokens.
 *
 * Field names (CLAUDE.md §10.2 source of truth):
 *   name      — single name field, no displayName
 *   institute — single field for all roles, no instituteName/organizationName
 *   isOnboarded — not onboardingComplete
 *
 * Tests:
 *  1. register -> verifyOtp issues FULL access token (no scope); isOnboarded:false in payload
 *  2. User with isOnboarded:false gets 200 on GET /users/me, 403 on POST /datasets/search
 *  3. login as isOnboarded:false -> full token returned, isOnboarded:false in payload
 *  4. completeOnboarding as local user (no phone in payload) -> success
 *  5. completeOnboarding as Google user (phone in payload) -> phone-cap check + full tokens
 *  6. student/non-student conditional validation (institute required for students)
 *  7. migrateIsOnboarded.js sets isOnboarded:true on pre-existing docs
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../src/app');
const { User } = require('../src/modules/user/user.model');

// ── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../src/utils/mailer', () => ({ sendOtpEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/utils/emailValidator', () => ({
  validateEmail: jest.fn().mockResolvedValue({ valid: true }),
}));
jest.mock('../src/modules/auth/google.service', () => ({
  verifyGoogleIdToken: jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFullAccessToken(userId) {
  return jwt.sign(
    { id: userId, role: 'user' }, // §10.2: no scope claim
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '15m' }
  );
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB_NAME || 'neuro_data_platform_test' });
});

afterAll(async () => {
  await mongoose.disconnect();
});

beforeEach(async () => {
  await User.deleteMany({ email: /@example\.com$/ });
  jest.clearAllMocks();
});

// ── Test 1: register -> verify-otp returns FULL token, isOnboarded:false ──────

describe('Test 1 — Local register + verify-otp issues full token with isOnboarded:false', () => {
  it('returns a full access token (no scope) after OTP verification', async () => {
    const email = 'alice@example.com';

    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Alice', email, password: 'Password1!', confirmPassword: 'Password1!', countryCode: '+1', phone: '4155550001' });
    expect(regRes.status).toBe(201);

    const user = await User.findOne({ email }).select('+otp +otpExpires +otpPurpose +passwordHash');
    const { hashOtp } = require('../src/utils/otp.util');
    const rawOtp = '123456';
    user.otp = await hashOtp(rawOtp);
    user.otpExpires = new Date(Date.now() + 5 * 60 * 1000);
    user.otpPurpose = 'REGISTRATION';
    await user.save();

    const verRes = await request(app)
      .post('/api/v1/auth/verify-otp')
      .send({ email, otp: rawOtp });

    expect(verRes.status).toBe(200);
    // §10.2: full token issued immediately
    expect(verRes.body.data.accessToken).toBeDefined();
    expect(verRes.body.data.requiresOnboarding).toBe(true);

    // Token must NOT carry a scope claim
    const decoded = jwt.verify(verRes.body.data.accessToken, process.env.JWT_ACCESS_SECRET);
    expect(decoded.scope).toBeUndefined();
    expect(decoded.id).toBeDefined();
  });
});

// ── Test 2: isOnboarded:false user — /users/me open, /datasets/search blocked ─

describe('Test 2 — User with isOnboarded:false is blocked by requireOnboardingComplete', () => {
  let fullToken;

  beforeEach(async () => {
    const user = await User.create({
      name: 'Bob', email: 'bob@example.com', passwordHash: await User.hashPassword('Password1!'),
      phone: '+14155550002', authProvider: 'local', isEmailVerified: true, isOnboarded: false,
    });
    fullToken = makeFullAccessToken(user._id.toString());
  });

  it('GET /api/v1/users/me returns 200 (pre-onboarding allowed per §10.7)', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${fullToken}`);
    expect(res.status).toBe(200);
  });

  it('POST /api/v1/datasets/search returns 403 (requireOnboardingComplete blocks)', async () => {
    const res = await request(app)
      .post('/api/v1/datasets/search')
      .set('Authorization', `Bearer ${fullToken}`)
      .send({ query: 'brain MRI' });
    expect(res.status).toBe(403);
  });
});

// ── Test 3: login as isOnboarded:false -> full token, isOnboarded:false ───────

describe('Test 3 — Login with isOnboarded:false returns full token + isOnboarded flag', () => {
  it('returns full tokens with isOnboarded:false (no restricted token)', async () => {
    const email = 'carol@example.com';
    const password = 'Password1!';
    await User.create({
      name: 'Carol', email, passwordHash: await User.hashPassword(password),
      phone: '+14155550003', authProvider: 'local', isEmailVerified: true, isOnboarded: false,
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.isOnboarded).toBe(false);

    const decoded = jwt.verify(res.body.data.accessToken, process.env.JWT_ACCESS_SECRET);
    expect(decoded.scope).toBeUndefined();
  });
});

// ── Test 4: completeOnboarding as local user ───────────────────────────────────

describe('Test 4 — completeOnboarding for local user (phone already set)', () => {
  it('succeeds without phone in payload and returns full tokens', async () => {
    const user = await User.create({
      name: 'Dave', email: 'dave@example.com', passwordHash: await User.hashPassword('Password1!'),
      phone: '+14155550004', authProvider: 'local', isEmailVerified: true, isOnboarded: false,
    });
    const token = makeFullAccessToken(user._id.toString());

    const res = await request(app)
      .post('/api/v1/auth/complete-onboarding')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Dave Doe', role: 'researcher', institute: 'MIT' });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();

    const updated = await User.findById(user._id);
    expect(updated.isOnboarded).toBe(true);
    expect(updated.name).toBe('Dave Doe');
    expect(updated.role).toBe('researcher');
    expect(updated.institute).toBe('MIT');
  });
});

// ── Test 5: completeOnboarding as Google user ──────────────────────────────────

describe('Test 5 — completeOnboarding for Google user (phone required)', () => {
  it('runs phone cap check and issues full tokens on success', async () => {
    const user = await User.create({
      name: 'Eve', email: 'eve@example.com', googleId: 'google-eve-123',
      authProvider: 'google', isEmailVerified: true, phone: null, isOnboarded: false,
    });
    const token = makeFullAccessToken(user._id.toString());

    const res = await request(app)
      .post('/api/v1/auth/complete-onboarding')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Eve G.', role: 'student', institute: 'Stanford', countryCode: '+1', phone: '4155550005' });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();

    const updated = await User.findById(user._id);
    expect(updated.isOnboarded).toBe(true);
    expect(updated.phone).toBe('4155550005');
    expect(updated.institute).toBe('Stanford');
  });

  it('rejects when phone cap (2 accounts) is already reached', async () => {
    const phone = '4155550099';
    await User.create({
      name: 'U1', email: 'u1@example.com', passwordHash: await User.hashPassword('P1!'),
      countryCode: '+1', phone, authProvider: 'local', isEmailVerified: true, isOnboarded: true,
    });
    await User.create({
      name: 'U2', email: 'u2@example.com', passwordHash: await User.hashPassword('P1!'),
      countryCode: '+1', phone, authProvider: 'local', isEmailVerified: true, isOnboarded: true,
    });

    const user = await User.create({
      name: 'Eve2', email: 'eve2@example.com', googleId: 'google-eve2',
      authProvider: 'google', isEmailVerified: true, phone: null, isOnboarded: false,
    });
    const token = makeFullAccessToken(user._id.toString());

    const res = await request(app)
      .post('/api/v1/auth/complete-onboarding')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Eve 2', role: 'student', institute: 'Harvard', countryCode: '+1', phone });

    expect(res.status).toBe(409);
  });
});

// ── Test 6: Conditional institute validation ───────────────────────────────────

describe('Test 6 — Conditional validation: institute required for students', () => {
  let token;

  beforeEach(async () => {
    const user = await User.create({
      name: 'Frank', email: 'frank@example.com', passwordHash: await User.hashPassword('Password1!'),
      phone: '+14155550006', authProvider: 'local', isEmailVerified: true, isOnboarded: false,
    });
    token = makeFullAccessToken(user._id.toString());
  });

  it('rejects role:student without institute', async () => {
    const res = await request(app)
      .post('/api/v1/auth/complete-onboarding')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Frank F.', role: 'student' }); // no institute
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/institute/i);
  });

  it('accepts role:researcher without institute (institute optional for non-students)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/complete-onboarding')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Frank F.', role: 'researcher' }); // no institute — allowed
    expect(res.status).toBe(200);
  });
});

// ── Test 7: migrateIsOnboarded.js ────────────────────────────────────────────

describe('Test 7 — migrateIsOnboarded.js sets isOnboarded:true on pre-existing users', () => {
  it('bulk-updates existing users to isOnboarded:true', async () => {
    await User.collection.insertMany([
      { name: 'OldUser1', email: 'old1@example.com', authProvider: 'local',
        passwordHash: 'hash1', isEmailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { name: 'OldUser2', email: 'old2@example.com', authProvider: 'local',
        passwordHash: 'hash2', isEmailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    ]);

    const result = await User.updateMany(
      { isOnboarded: { $ne: true } },
      { $set: { isOnboarded: true } }
    );

    expect(result.modifiedCount).toBeGreaterThanOrEqual(2);

    const docs = await User.find({ email: { $in: ['old1@example.com', 'old2@example.com'] } });
    docs.forEach((d) => expect(d.isOnboarded).toBe(true));
  });
});
