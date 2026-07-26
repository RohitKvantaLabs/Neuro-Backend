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

app.set('trust proxy', 1);
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

app.use(notFound);
app.use(errorHandler); // must be last

module.exports = app;
