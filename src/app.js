const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const passport = require("passport");
const cookieParser = require("cookie-parser");
require("dotenv").config({ quiet: true });

const routes = require("./routes");
const {
  errorHandler,
  notFoundHandler,
} = require("./middlewares/error-handler");
const { initPassport } = require("./configs/passport");
const localeMiddleware = require("./middlewares/locale.middleware");
const { t } = require("./utils/i18n.util");

initPassport();

const app = express();
app.disable("x-powered-by");

// Chặn sớm các request dò quét file nhạy cảm (.env, .git, path traversal)
// trước khi tới router, tránh lộ thông tin và giảm rác log lỗi 404.
const BLOCKED_PATH_PATTERN = /(^|\/)\.env(\.|$|\?)|\.git(\/|$)|\.\.\//i;
app.use((req, res, next) => {
  if (BLOCKED_PATH_PATTERN.test(req.originalUrl)) {
    return res.status(403).end();
  }
  next();
});

const trustProxy = process.env.TRUST_PROXY;
if (trustProxy === "true") {
  app.set("trust proxy", true);
} else if (/^\d+$/.test(trustProxy || "")) {
  app.set("trust proxy", Number(trustProxy));
} else if (trustProxy) {
  app.set(
    "trust proxy",
    trustProxy
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
} else if (process.env.NODE_ENV === "development") {
  // The local/dev deployment is commonly reached through one reverse proxy.
  // Setting one trusted hop also keeps rate-limit IP validation deterministic.
  app.set("trust proxy", 1);
}

const corsOrigins = process.env.CORS_ORIGINS || "*";
let allowedOrigins = corsOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsAllowCredentials = true;
if (corsAllowCredentials && allowedOrigins.includes("*")) {
  allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://103.163.119.247:32026",
    "http://103.163.119.247:42026",
  ];
}

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "frame-ancestors": ["'self'", ...allowedOrigins],
      },
    },
  }),
);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (allowedOrigins.includes("*")) {
      return callback(null, true);
    }
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    return callback(
      new Error("CORS policy does not allow access from the specified Origin."),
      false,
    );
  },
  credentials: corsAllowCredentials,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "x-anonymous-id",
    "X-Map-Api-Key",
  ],
  exposedHeaders: [
    "Content-Range",
    "X-Content-Range",
    "X-RateLimit-Limit",
    "X-RateLimit-Remaining",
    "X-RateLimit-Reset",
    "Retry-After",
  ],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.use(passport.initialize());
app.use(cookieParser());
app.use(localeMiddleware);

const bodyLimit = process.env.REQUEST_BODY_LIMIT || "2mb";
app.use(express.json({ limit: bodyLimit }));
app.use(
  express.urlencoded({
    extended: true,
    limit: bodyLimit,
    parameterLimit: 1000,
  }),
);
app.use("/uploads", express.static("public/uploads"));
app.use(
  compression({
    filter: (req, res) => {
      if (
        req.headers["accept"] === "text/event-stream" ||
        res.getHeader("Content-Type") === "text/event-stream"
      ) {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
} else {
  app.use(morgan("combined"));
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 1000,
  message: {
    success: false,
    message: "Too many requests, please try again after 15 minutes.",
    errors: ["TOO_MANY_REQUESTS"],
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiter chặt hơn cho nhóm xác thực (chống brute-force / dò mật khẩu).
// Chỉ tính các request thất bại nên không ảnh hưởng người dùng hợp lệ.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 30,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    message: "Too many authentication requests, please try again later.",
    errors: ["TOO_MANY_AUTH_REQUESTS"],
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const expensiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.EXPENSIVE_RATE_LIMIT_MAX, 10) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many expensive requests.",
    errors: ["TOO_MANY_REQUESTS"],
  },
});

app.use("/api/", limiter);
app.use("/api/v1/auth", authLimiter);
app.use(
  [
    "/api/v1/remote-sensing",
    "/api/v1/satellite",
    "/api/v1/spatial",
    "/api/v1/fire-risk",
    "/api/v1/forest-classification",
  ],
  expensiveLimiter,
);

app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

app.use("/api/v1", routes);

app.get("/", (req, res) => {
  res.json({
    status: "success",
    message: t("root_welcome", req.lang),
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
