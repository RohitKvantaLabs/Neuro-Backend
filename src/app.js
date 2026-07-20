const express = require('express');
const helmet = require('helmet');
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

// 1. Security headers first (no body needed)
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    // Requests without an Origin header (health checks and server-to-server calls)
    // are safe to allow; browser requests must match an explicitly configured UI origin.
    if (!origin || env.frontendOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: true,
}));

// 2. Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 3. Sanitization - ponytail: Express 5 makes req.query a getter (non-writable),
// so mongoSanitize() middleware crashes on reassignment. Sanitize body in-place instead.
app.use((req, res, next) => { mongoSanitize.sanitize(req.body); next(); });

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

app.use(notFound);
app.use(errorHandler); // must be last

module.exports = app;
