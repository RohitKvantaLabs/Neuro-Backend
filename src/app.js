const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');

const env = require('./config/env.config');
const connectDB = require('./config/db.config');
const requestLogger = require('./middleware/requestLogger');
const { generalLimiter } = require('./middleware/rateLimiter');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const apiRouter = require('./routes');

const app = express();

app.set('trust proxy', 1);
// 1. Security headers first (no body needed)
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    // Requests without an Origin header (health checks and server-to-server calls)
    // are safe to allow; browser requests must match an explicitly configured UI origin.
    // ponytail: allow all vercel.app subdomains to prevent CORS issues on preview deployments
    if (!origin || env.frontendOrigins.includes(origin) || /\.vercel\.app$/.test(origin)) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: true,
}));

// 1b. Response compression — gzip/brotli for JSON and text responses >= 1 KB.
// The middleware checks Content-Encoding to avoid double-compressing already-
// compressed payloads (e.g. when Vercel Edge or a CDN compresses upstream).
app.use(compression({
  // Only compress responses above this threshold (1 KB) — tiny responses
  // (health checks, 204s, redirects) don't benefit from compression.
  threshold: 1024,
  // Skip responses that are already compressed.
  filter: (req, res) => {
    if (res.getHeader('Content-Encoding')) return false;
    // fall back to compression's default filter (content-type sniffing)
    return compression.filter(req, res);
  },
}));

// 2. Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 3. Sanitization — strip $ and . from MongoDB query operators to prevent
// NoSQL injection via req.body and req.query.  req.params are sanitised by
// each controller that passes them to MongoDB (cast to ObjectId).
// ponytail: Express 5 makes req.query a getter (non-writable), so
// mongoSanitize.sanitize() mutates the returned object in-place, which is
// sufficient to strip operator keys before they reach any route handler.
app.use((req, res, next) => {
  mongoSanitize.sanitize(req.body);
  if (req.query) mongoSanitize.sanitize(req.query);
  next();
});

// 4. Logging + rate limiting
app.use(requestLogger);
app.use(generalLimiter);

// 5. Database connection middleware (ensures MongoDB is connected in Vercel serverless functions)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    next(err);
  }
});

app.use('/api/v1', apiRouter);
app.use('/v1', apiRouter);
app.use('/', apiRouter);

app.use(notFound);
app.use(errorHandler); // must be last

module.exports = app;
