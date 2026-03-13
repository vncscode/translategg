import express, { type Request, type Response, type NextFunction } from "express"
import cors from "cors"
import dotenv from "dotenv"
import { createLogger, format, transports } from "winston"
import DailyRotateFile from "winston-daily-rotate-file"
import type { TranslationRequest, TranslationResponse, ApiError } from "./interfaces/translation.interface"
import { getStatsData, recordSuccess, recordFailure } from "./controllers/translate.save"
import path from "path"

// Configuração de ambiente
dotenv.config()

// Configuração avançada de logging
const { combine, timestamp, printf, errors, splat, json } = format

const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}]: ${message} ${stack || ""}`
})

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), errors({ stack: true }), splat(), json()),
  transports: [
    new transports.Console({
      format: combine(format.colorize(), logFormat),
    }),
    new DailyRotateFile({
      filename: "logs/translate-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      zippedArchive: true,
      maxSize: "20m",
      maxFiles: "14d",
      format: combine(timestamp(), errors({ stack: true }), json()),
    }),
  ],
  exceptionHandlers: [new transports.File({ filename: "logs/exceptions.log" })],
})

// Criação do servidor Express
const app = express()

// Configuração de CORS
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(",") || "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}

app.use(cors(corsOptions))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, "../public")))

// Middleware de logging para requisições
app.use((req: Request, res: Response, next: NextFunction) => {
  logger.info(`Request: ${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get("User-Agent"),
    body: req.body,
  })
  next()
})

// Rota para o dashboard
app.get("/", (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "../public/index.html"))
})

// Health Check Endpoint
app.get("/health", (req: Request, res: Response) => {
  const healthCheck = {
    status: "operational",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: "connected", // Adicione verificações reais de dependências aqui
    memoryUsage: process.memoryUsage(),
  }

  logger.info("Health check performed", healthCheck)
  res.status(200).json(healthCheck)
})

// Rota para estatísticas da API
app.get("/api/v1/stats", async (req: Request, res: Response) => {
  try {
    const stored = await getStatsData();
    const sortLangs = (langs: Record<string, number>) => {
      return Object.entries(langs)
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
    };

    const avgTime = stored.successfulTranslations > 0 
      ? stored.totalResponseTime / stored.successfulTranslations 
      : 0;

    const statsResponse = {
      totalRequests: stored.totalRequests,
      successfulTranslations: stored.successfulTranslations,
      failedTranslations: stored.failedTranslations,
      averageResponseTime: Number(avgTime.toFixed(2)),
      topSourceLanguages: sortLangs(stored.sourceLanguages),
      topTargetLanguages: sortLangs(stored.targetLanguages),
      lastUpdated: stored.lastUpdated,
    };

    res.status(200).json(statsResponse);
  } catch (error) {
    logger.error("Error fetching stats", error);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

// Rota principal de tradução
app.post("/api/v1/translate", async (req: Request, res: Response) => {
  const startTime = process.hrtime()
  const { text, targetLang = "en", sourceLang }: TranslationRequest = req.body

  // Validação dos parâmetros
  if (!text) {
    const error: ApiError = {
      error: "Missing required parameter",
      message: 'O parâmetro "text" é obrigatório',
      code: "MISSING_TEXT_PARAMETER",
    }
    logger.warn("Validation failed", error)
    return res.status(400).json(error)
  }

  if (typeof text !== "string") {
    const error: ApiError = {
      error: "Invalid parameter type",
      message: 'O parâmetro "text" deve ser uma string',
      code: "INVALID_TEXT_TYPE",
    }
    logger.warn("Validation failed", error)
    return res.status(400).json(error)
  }

  try {
    logger.info(`Starting translation for text: ${text.substring(0, 50)}...`, {
      targetLang,
      sourceLang,
      textLength: text.length,
    })

    const { translate } = await import("@vitalets/google-translate-api")
    
    const result = await translate(text, {
      to: targetLang,
      from: sourceLang, // Se for undefined, é Auto-Detect
    })

    let detectedLanguage = "unknown"
    if (result.raw) {
      const rawResponse = result.raw as any
      if (
        rawResponse.ld_result && 
        rawResponse.ld_result.srclangs && 
        rawResponse.ld_result.srclangs.length > 0
      ) {
        detectedLanguage = rawResponse.ld_result.srclangs[0]
      } 
      else if (rawResponse.src) {
        detectedLanguage = rawResponse.src
      } 
      else if (rawResponse.detectedLanguage) {
        detectedLanguage = rawResponse.detectedLanguage
      }
    }
    
    if (detectedLanguage === "unknown" && result.raw) {
      const rawResponse = result.raw as any
      if (rawResponse.ld_result?.srclangs?.[0]) {
        detectedLanguage = rawResponse.ld_result.srclangs[0]
      }
    }

    let finalTranslatedText = result.text;
    const isTextUnchanged = finalTranslatedText.trim().toLowerCase() === text.trim().toLowerCase();
    const isLanguageDifferent = detectedLanguage !== "unknown" && detectedLanguage !== targetLang;

    if (isTextUnchanged && isLanguageDifferent) {
        logger.info(`Re-translating triggered. Detected: ${detectedLanguage}, Target: ${targetLang}`);
        
        const retryResult = await translate(text, {
            to: targetLang,
            from: detectedLanguage
        });
        
        finalTranslatedText = retryResult.text;
    }

    const [seconds, nanoseconds] = process.hrtime(startTime)
    const responseTime = seconds * 1000 + nanoseconds / 1e6

    void recordSuccess(responseTime, detectedLanguage, targetLang); 

    const response: TranslationResponse = {
      originalText: text,
      translatedText: finalTranslatedText,
      detectedLanguage: detectedLanguage,
      targetLanguage: targetLang,
      translationTime: responseTime,
      timestamp: new Date().toISOString(),
    }

    logger.info("Translation completed successfully", {
      responseTime: `${responseTime.toFixed(2)}ms`,
      detectedLanguage: response.detectedLanguage,
      targetLanguage: response.targetLanguage,
      resultPreview: finalTranslatedText.substring(0, 20)
    })

    res.status(200).json(response)

  } catch (error: unknown) {
    void recordFailure();

    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    const errorStack = error instanceof Error ? error.stack : undefined

    const apiError: ApiError = {
      error: "Translation failed",
      message: errorMessage,
      code: "TRANSLATION_ERROR",
      details: process.env.NODE_ENV === "development" ? errorStack : undefined,
    }

    logger.error("Translation failed", {
      error: apiError,
      stack: errorStack,
    })

    res.status(500).json(apiError)
  }
})
app.use((req: Request, res: Response) => {
  const error: ApiError = {
    error: "Endpoint not found",
    message: `O caminho ${req.path} não existe`,
    code: "ENDPOINT_NOT_FOUND",
  }

  logger.warn(`Route not found: ${req.method} ${req.path}`, error)
  res.status(404).json(error)
})

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  const errorMessage = err instanceof Error ? err.message : "Unknown error"
  const errorStack = err instanceof Error ? err.stack : undefined

  const error: ApiError = {
    error: "Internal server error",
    message: errorMessage,
    code: "INTERNAL_SERVER_ERROR",
    details: process.env.NODE_ENV === "development" ? errorStack : undefined,
  }

  logger.error("Internal server error occurred", {
    error,
    path: req.path,
    method: req.method,
    stack: errorStack,
  })

  res.status(500).json(error)
})


const PORT = Number.parseInt(process.env.PORT || "3000", 10)
const server = app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`, {
    environment: process.env.NODE_ENV || "development",
    nodeVersion: process.version,
  })
})

const shutdown = (signal: string) => {
  logger.info(`${signal} received. Shutting down gracefully...`)

  server.close(() => {
    logger.info("HTTP server closed")
    process.exit(0)
  })


  setTimeout(() => {
    logger.error("Forcing shutdown due to timeout")
    process.exit(1)
  }, 5000)
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", { promise, reason })
})

process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception thrown:", error)
  process.exit(1)
})
