"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Camera,
  CameraOff,
  AlertTriangle,
  Eye,
  Activity,
  Bell,
  Volume2,
  Smartphone,
  BarChart3,
  TrendingUp,
  Download,
  Clock,
  Calendar,
  Target,
} from "lucide-react"

interface FaceLandmarks {
  leftEye: { x: number; y: number }[]
  rightEye: { x: number; y: number }[]
  nose: { x: number; y: number }[]
  mouth: { x: number; y: number }[]
}

interface DetectionResult {
  box: { x: number; y: number; width: number; height: number }
  landmarks: FaceLandmarks
  confidence: number
}

interface DrowsinessConfig {
  earThreshold: number
  consecutiveFrames: number
  blinkThreshold: number
  yawnThreshold: number
  alertCooldown: number
}

interface DetectionHistory {
  earValues: number[]
  blinkStates: boolean[]
  timestamps: number[]
  maxHistoryLength: number
  eyeClosureStartTime: number | null
  lastEyeClosureDuration: number
}

interface AlertConfig {
  audioEnabled: boolean
  visualEnabled: boolean
  browserNotifications: boolean
  vibrationEnabled: boolean
  volume: number
  alertSound: string
}

interface AlertState {
  isActive: boolean
  level: "low" | "medium" | "high" | "critical"
  message: string
  timestamp: number
}

interface SessionData {
  id: string
  startTime: number
  endTime?: number
  duration: number
  totalBlinks: number
  totalAlerts: number
  avgEAR: number
  maxDrowsinessScore: number
  alertsByLevel: Record<string, number>
  earHistory: Array<{ timestamp: number; value: number }>
  drowsinessHistory: Array<{ timestamp: number; value: number }>
}

interface AnalyticsData {
  currentSession: SessionData | null
  sessions: SessionData[]
  realTimeData: Array<{ timestamp: number; ear: number; drowsiness: number; blinks: number }>
  maxDataPoints: number
}

interface Stats {
  eyeAspectRatio: number
  blinkCount: number
  alertCount: number
  faceDetected: boolean
  blinkRate: number
  avgEAR: number
  drowsinessScore: number
  eyeClosureDuration: number
  currentEAR: number
}

export default function DrowsinessDetectionPage() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef<number>()
  const modelRef = useRef<any>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const alertTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const detectionHistoryRef = useRef<DetectionHistory>({
    earValues: [],
    blinkStates: [],
    timestamps: [],
    maxHistoryLength: 100,
    eyeClosureStartTime: null,
    lastEyeClosureDuration: 0,
  })

  const lastBlinkRef = useRef<number>(0)
  const lastAlertRef = useRef<number>(0)
  const consecutiveDrowsyFramesRef = useRef<number>(0)

  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detectionStatus, setDetectionStatus] = useState<"idle" | "active" | "drowsy">("idle")
  const [isModelLoading, setIsModelLoading] = useState(false)
  const [modelLoaded, setModelLoaded] = useState(false)
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>("default")

  const [stats, setStats] = useState<Stats>({
    eyeAspectRatio: 0,
    blinkCount: 0,
    alertCount: 0,
    faceDetected: false,
    blinkRate: 0, // blinks per minute
    avgEAR: 0,
    drowsinessScore: 0,
    eyeClosureDuration: 0,
    currentEAR: 0,
  })

  const [config, setConfig] = useState<DrowsinessConfig>({
    earThreshold: 0.25,
    consecutiveFrames: 10, // frames below threshold to trigger alert
    blinkThreshold: 0.2, // EAR threshold for blink detection
    yawnThreshold: 0.6, // mouth aspect ratio for yawn detection
    alertCooldown: 3000, // milliseconds between alerts
  })

  const [alertConfig, setAlertConfig] = useState<AlertConfig>({
    audioEnabled: true,
    visualEnabled: true,
    browserNotifications: true,
    vibrationEnabled: true,
    volume: 0.8,
    alertSound: "alarm",
  })

  const [alertState, setAlertState] = useState<AlertState>({
    isActive: false,
    level: "low",
    message: "",
    timestamp: 0,
  })

  const [analytics, setAnalytics] = useState<AnalyticsData>({
    currentSession: null,
    sessions: [],
    realTimeData: [],
    maxDataPoints: 300, // 5 minutes at 1 data point per second
  })

  const [activeTab, setActiveTab] = useState("detection")
  const [lastAlertTime, setLastAlertTime] = useState(0)

  const startSession = useCallback(() => {
    const sessionId = `session_${Date.now()}`
    const newSession: SessionData = {
      id: sessionId,
      startTime: Date.now(),
      duration: 0,
      totalBlinks: 0,
      totalAlerts: 0,
      avgEAR: 0,
      maxDrowsinessScore: 0,
      alertsByLevel: { low: 0, medium: 0, high: 0, critical: 0 },
      earHistory: [],
      drowsinessHistory: [],
    }

    setAnalytics((prev) => ({
      ...prev,
      currentSession: newSession,
    }))
  }, [])

  const endSession = useCallback(() => {
    setAnalytics((prev) => {
      if (!prev.currentSession) return prev

      const endedSession: SessionData = {
        ...prev.currentSession,
        endTime: Date.now(),
        duration: Date.now() - prev.currentSession.startTime,
        totalBlinks: stats.blinkCount,
        totalAlerts: stats.alertCount,
        avgEAR: stats.avgEAR,
        maxDrowsinessScore: Math.max(prev.currentSession.maxDrowsinessScore, stats.drowsinessScore),
      }

      return {
        ...prev,
        currentSession: null,
        sessions: [endedSession, ...prev.sessions.slice(0, 49)], // Keep last 50 sessions
      }
    })
  }, [stats])

  const updateAnalytics = useCallback(
    (earValue: number, drowsinessScore: number, alertLevel?: string) => {
      const timestamp = Date.now()

      setAnalytics((prev) => {
        const newRealTimeData = [
          ...prev.realTimeData,
          { timestamp, ear: earValue, drowsiness: drowsinessScore, blinks: stats.blinkRate },
        ].slice(-prev.maxDataPoints)

        let updatedSession = prev.currentSession
        if (updatedSession) {
          updatedSession = {
            ...updatedSession,
            duration: timestamp - updatedSession.startTime,
            maxDrowsinessScore: Math.max(updatedSession.maxDrowsinessScore, drowsinessScore),
            earHistory: [...updatedSession.earHistory, { timestamp, value: earValue }].slice(-1000),
            drowsinessHistory: [...updatedSession.drowsinessHistory, { timestamp, value: drowsinessScore }].slice(
              -1000,
            ),
          }

          if (alertLevel) {
            updatedSession.alertsByLevel[alertLevel] = (updatedSession.alertsByLevel[alertLevel] || 0) + 1
          }
        }

        return {
          ...prev,
          realTimeData: newRealTimeData,
          currentSession: updatedSession,
        }
      })
    },
    [stats.blinkRate],
  )

  const exportSessionData = useCallback(() => {
    const dataToExport = {
      sessions: analytics.sessions,
      currentSession: analytics.currentSession,
      exportTime: new Date().toISOString(),
      systemConfig: config,
    }

    const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `drowsiness_data_${new Date().toISOString().split("T")[0]}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [analytics, config])

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`
    } else {
      return `${seconds}s`
    }
  }

  const getSessionGrade = (session: SessionData) => {
    const alertRate = session.totalAlerts / (session.duration / 60000) // alerts per minute
    const avgDrowsiness = session.maxDrowsinessScore

    if (alertRate > 2 || avgDrowsiness > 70) return { grade: "Poor", color: "text-red-600" }
    if (alertRate > 1 || avgDrowsiness > 50) return { grade: "Fair", color: "text-yellow-600" }
    if (alertRate > 0.5 || avgDrowsiness > 30) return { grade: "Good", color: "text-blue-600" }
    return { grade: "Excellent", color: "text-green-600" }
  }

  useEffect(() => {
    // Request notification permission
    if ("Notification" in window) {
      Notification.requestPermission().then((permission) => {
        setNotificationPermission(permission)
      })
    }

    // Initialize audio
    if (typeof window !== "undefined") {
      audioRef.current = new Audio()
      audioRef.current.loop = true
      audioRef.current.volume = alertConfig.volume
    }

    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [])

  const generateAlertSound = useCallback(
    (frequency = 800, duration = 200) => {
      if (!alertConfig.audioEnabled || typeof window === "undefined") return

      try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
        const oscillator = audioContext.createOscillator()
        const gainNode = audioContext.createGain()

        oscillator.connect(gainNode)
        gainNode.connect(audioContext.destination)

        oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime)
        oscillator.type = "sine"

        gainNode.gain.setValueAtTime(0, audioContext.currentTime)
        gainNode.gain.linearRampToValueAtTime(alertConfig.volume, audioContext.currentTime + 0.01)
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration / 1000)

        oscillator.start(audioContext.currentTime)
        oscillator.stop(audioContext.currentTime + duration / 1000)
      } catch (error) {
        console.error("[v0] Audio generation error:", error)
      }
    },
    [alertConfig.audioEnabled, alertConfig.volume],
  )

  const triggerAlert = useCallback(
    (level: AlertState["level"], message: string) => {
      const timestamp = Date.now()

      setAlertState({
        isActive: true,
        level,
        message,
        timestamp,
      })

      // Audio alerts with different patterns based on severity
      if (alertConfig.audioEnabled) {
        switch (level) {
          case "low":
            generateAlertSound(600, 300)
            break
          case "medium":
            generateAlertSound(800, 400)
            setTimeout(() => generateAlertSound(800, 400), 500)
            break
          case "high":
            generateAlertSound(1000, 500)
            setTimeout(() => generateAlertSound(1000, 500), 600)
            setTimeout(() => generateAlertSound(1000, 500), 1200)
            break
          case "critical":
            // Continuous alarm pattern
            const playAlarm = () => {
              generateAlertSound(1200, 200)
              setTimeout(() => generateAlertSound(800, 200), 250)
            }
            playAlarm()
            setTimeout(playAlarm, 500)
            setTimeout(playAlarm, 1000)
            setTimeout(playAlarm, 1500)
            break
        }
      }

      // Browser notifications
      if (alertConfig.browserNotifications && notificationPermission === "granted") {
        const notification = new Notification("Drowsiness Alert", {
          body: message,
          icon: "/favicon.ico",
          badge: "/favicon.ico",
          tag: "drowsiness-alert",
          requireInteraction: level === "critical",
          silent: !alertConfig.audioEnabled,
        })

        notification.onclick = () => {
          window.focus()
          notification.close()
        }

        // Auto-close notification after 5 seconds unless critical
        if (level !== "critical") {
          setTimeout(() => notification.close(), 5000)
        }
      }

      // Vibration for mobile devices
      if (alertConfig.vibrationEnabled && "vibrate" in navigator) {
        switch (level) {
          case "low":
            navigator.vibrate(200)
            break
          case "medium":
            navigator.vibrate([200, 100, 200])
            break
          case "high":
            navigator.vibrate([300, 100, 300, 100, 300])
            break
          case "critical":
            navigator.vibrate([500, 200, 500, 200, 500, 200, 500])
            break
        }
      }

      // Auto-dismiss alert after timeout
      if (alertTimeoutRef.current) {
        clearTimeout(alertTimeoutRef.current)
      }

      const timeoutDuration = level === "critical" ? 10000 : level === "high" ? 7000 : 5000
      alertTimeoutRef.current = setTimeout(() => {
        setAlertState((prev) => ({ ...prev, isActive: false }))
      }, timeoutDuration)

      console.log(`[v0] ${level.toUpperCase()} alert triggered: ${message}`)
    },
    [alertConfig, notificationPermission, generateAlertSound],
  )

  const dismissAlert = useCallback(() => {
    setAlertState((prev) => ({ ...prev, isActive: false }))
    if (alertTimeoutRef.current) {
      clearTimeout(alertTimeoutRef.current)
      alertTimeoutRef.current = null
    }
    if (audioRef.current) {
      audioRef.current.pause()
    }
  }, [])

  const loadFaceDetectionModel = useCallback(async () => {
    try {
      setIsModelLoading(true)
      setError(null)

      const tf = await import("@tensorflow/tfjs")
      const faceDetection = await import("@tensorflow-models/face-landmarks-detection")

      await tf.ready()

      const model = faceDetection.SupportedModels.MediaPipeFaceMesh
      const detectorConfig = {
        runtime: "tfjs" as const,
        maxFaces: 1,
        refineLandmarks: false, // Disable for better performance with tfjs runtime
      }

      console.log("[v0] Creating face detection model with TensorFlow.js runtime...")
      const detector = await faceDetection.createDetector(model, detectorConfig)

      modelRef.current = detector
      setModelLoaded(true)
      console.log("[v0] Face detection model loaded successfully")
    } catch (err) {
      console.error("[v0] Model loading error:", err)
      setError(
        "Failed to load face detection model. This may be due to browser compatibility. Please try refreshing or use a different browser.",
      )
    } finally {
      setIsModelLoading(false)
    }
  }, [])

  const calculateEyeAspectRatio = (eyePoints: { x: number; y: number }[]) => {
    if (eyePoints.length < 6) return 0

    // Calculate vertical distances
    const v1 = Math.sqrt(Math.pow(eyePoints[1].x - eyePoints[5].x, 2) + Math.pow(eyePoints[1].y - eyePoints[5].y, 2))
    const v2 = Math.sqrt(Math.pow(eyePoints[2].x - eyePoints[4].x, 2) + Math.pow(eyePoints[2].y - eyePoints[4].y, 2))

    // Calculate horizontal distance
    const h = Math.sqrt(Math.pow(eyePoints[0].x - eyePoints[3].x, 2) + Math.pow(eyePoints[0].y - eyePoints[3].y, 2))

    // Eye aspect ratio
    return (v1 + v2) / (2.0 * h)
  }

  const calculateMouthAspectRatio = (mouthPoints: { x: number; y: number }[]) => {
    if (mouthPoints.length < 6) return 0

    // Calculate vertical distance (mouth height)
    const v1 = Math.sqrt(
      Math.pow(mouthPoints[2].x - mouthPoints[6].x, 2) + Math.pow(mouthPoints[2].y - mouthPoints[6].y, 2),
    )
    const v2 = Math.sqrt(
      Math.pow(mouthPoints[3].x - mouthPoints[7].x, 2) + Math.pow(mouthPoints[3].y - mouthPoints[7].y, 2),
    )

    // Calculate horizontal distance (mouth width)
    const h = Math.sqrt(
      Math.pow(mouthPoints[0].x - mouthPoints[4].x, 2) + Math.pow(mouthPoints[0].y - mouthPoints[4].y, 2),
    )

    return (v1 + v2) / (2.0 * h)
  }

  const analyzeDrowsinessPattern = (currentEAR: number, timestamp: number) => {
    const history = detectionHistoryRef.current

    // Add current values to history
    history.earValues.push(currentEAR)
    history.timestamps.push(timestamp)

    // Maintain history length
    if (history.earValues.length > history.maxHistoryLength) {
      history.earValues.shift()
      history.timestamps.shift()
      history.blinkStates.shift()
    }

    const isEyesClosed = currentEAR < config.earThreshold
    let eyeClosureDuration = 0

    if (isEyesClosed) {
      // Eyes are closed
      if (history.eyeClosureStartTime === null) {
        // Start tracking eye closure
        history.eyeClosureStartTime = timestamp
        console.log("[v0] Started tracking eye closure at:", new Date(timestamp).toLocaleTimeString())
      }
      eyeClosureDuration = timestamp - history.eyeClosureStartTime
    } else {
      // Eyes are open
      if (history.eyeClosureStartTime !== null) {
        // Eyes just opened, record the closure duration
        history.lastEyeClosureDuration = timestamp - history.eyeClosureStartTime
        console.log("[v0] Eye closure ended. Duration:", history.lastEyeClosureDuration, "ms")
        history.eyeClosureStartTime = null
      }
      eyeClosureDuration = 0
    }

    // Detect blink vs sustained closure
    const isBlink = isEyesClosed && eyeClosureDuration < 500 // Blinks are typically < 500ms
    const isSustainedClosure = eyeClosureDuration >= 3000 // 3 seconds or more

    history.blinkStates.push(isBlink)

    // Count blinks in the last minute (exclude sustained closures)
    const oneMinuteAgo = timestamp - 60000
    const recentBlinks = history.timestamps.reduce((count, ts, index) => {
      if (ts > oneMinuteAgo && history.blinkStates[index]) {
        return count + 1
      }
      return count
    }, 0)

    // Calculate average EAR over recent history
    const avgEAR =
      history.earValues.length > 0 ? history.earValues.reduce((sum, ear) => sum + ear, 0) / history.earValues.length : 0

    // Check for sustained low EAR (drowsiness indicator)
    const recentLowEARCount = history.earValues
      .slice(-config.consecutiveFrames)
      .filter((ear) => ear < config.earThreshold).length
    const isDrowsy = recentLowEARCount >= config.consecutiveFrames * 0.8 // 80% of recent frames below threshold

    // Calculate drowsiness score (0-100)
    const earScore = Math.max(0, ((config.earThreshold - avgEAR) / config.earThreshold) * 100)
    const blinkScore = Math.max(0, ((15 - recentBlinks) / 15) * 100) // Normal blink rate ~15-20/min
    let drowsinessScore = Math.min(100, (earScore + blinkScore) / 2)

    if (isSustainedClosure) {
      drowsinessScore = Math.max(drowsinessScore, 95) // Force high score for 3+ second closure
    }

    let alertLevel: AlertState["level"] = "low"
    let alertMessage = ""

    if (isSustainedClosure) {
      alertLevel = "critical"
      alertMessage = `CRITICAL: Eyes closed for ${Math.round(eyeClosureDuration / 1000)} seconds! Wake up immediately!`
      console.log("[v0] SUSTAINED EYE CLOSURE DETECTED:", eyeClosureDuration, "ms")
    } else if (drowsinessScore > 80) {
      alertLevel = "critical"
      alertMessage = "CRITICAL: Severe drowsiness detected! Please stop and rest immediately."
    } else if (drowsinessScore > 60) {
      alertLevel = "high"
      alertMessage = "HIGH ALERT: Significant drowsiness detected. Consider taking a break."
    } else if (drowsinessScore > 40) {
      alertLevel = "medium"
      alertMessage = "MODERATE: Drowsiness signs detected. Stay alert."
    } else if (isDrowsy) {
      alertLevel = "low"
      alertMessage = "NOTICE: Mild drowsiness detected."
    }

    return {
      isDrowsy: isDrowsy || isSustainedClosure,
      blinkRate: recentBlinks,
      avgEAR,
      drowsinessScore,
      alertLevel,
      alertMessage,
      eyeClosureDuration,
      isSustainedClosure,
    }
  }

  const detectFaceAndEyes = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || !modelRef.current || !isStreaming) {
      return
    }

    const video = videoRef.current
    const canvas = canvasRef.current
    const ctx = canvas.getContext("2d")

    if (!ctx || video.videoWidth === 0 || video.videoHeight === 0) {
      return
    }

    // Set canvas dimensions to match video
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    try {
      const predictions = await modelRef.current.estimateFaces(video)

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (predictions.length > 0) {
        const face = predictions[0]
        const keypoints = face.keypoints
        const timestamp = Date.now()

        // Draw face mesh
        ctx.strokeStyle = "#00ff00"
        ctx.lineWidth = 1
        ctx.fillStyle = "#00ff00"

        // Extract eye landmarks (MediaPipe face mesh indices)
        const leftEyeIndices = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
        const rightEyeIndices = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]

        const mouthIndices = [61, 84, 17, 314, 405, 320, 307, 375, 321, 308, 324, 318]

        const leftEyePoints = leftEyeIndices.map((i) => keypoints[i]).filter(Boolean)
        const rightEyePoints = rightEyeIndices.map((i) => keypoints[i]).filter(Boolean)
        const mouthPoints = mouthIndices.map((i) => keypoints[i]).filter(Boolean)

        // Draw eye landmarks with color coding based on drowsiness
        const leftEAR = calculateEyeAspectRatio(leftEyePoints)
        const rightEAR = calculateEyeAspectRatio(rightEyePoints)
        const avgEAR = (leftEAR + rightEAR) / 2

        const eyeColor = avgEAR < config.earThreshold ? "#ff0000" : "#00ff00"

        ctx.fillStyle = eyeColor
        leftEyePoints.forEach((point) => {
          ctx.beginPath()
          ctx.arc(point.x, point.y, 2, 0, 2 * Math.PI)
          ctx.fill()
        })

        rightEyePoints.forEach((point) => {
          ctx.beginPath()
          ctx.arc(point.x, point.y, 2, 0, 2 * Math.PI)
          ctx.fill()
        })

        const mouthAR = calculateMouthAspectRatio(mouthPoints)
        const mouthColor = mouthAR > config.yawnThreshold ? "#ff8800" : "#0088ff"

        ctx.fillStyle = mouthColor
        mouthPoints.forEach((point) => {
          ctx.beginPath()
          ctx.arc(point.x, point.y, 2, 0, 2 * Math.PI)
          ctx.fill()
        })

        const analysis = analyzeDrowsinessPattern(avgEAR, timestamp)

        // Draw face bounding box with status color
        if (face.box) {
          const box = face.box
          ctx.strokeStyle = analysis.isDrowsy ? "#ff0000" : "#00ff00"
          ctx.lineWidth = 3
          ctx.strokeRect(box.xMin, box.yMin, box.width, box.height)

          ctx.fillStyle = analysis.isDrowsy ? "#ff0000" : "#00ff00"
          ctx.font = "16px Arial"
          ctx.fillText(`Drowsiness: ${analysis.drowsinessScore.toFixed(1)}%`, box.xMin, box.yMin - 10)

          if (mouthAR > config.yawnThreshold) {
            ctx.fillStyle = "#ff8800"
            ctx.fillText("YAWN DETECTED", box.xMin, box.yMin + box.height + 20)
          }
        }

        if (analysis.isSustainedClosure && alertState.level !== "critical") {
          console.log("[v0] Triggering sustained closure alert")
          triggerAlert(analysis.alertLevel, analysis.alertMessage)
        } else if (analysis.isDrowsy && Date.now() - lastAlertTime > config.alertCooldown) {
          triggerAlert(analysis.alertLevel, analysis.alertMessage)
          setLastAlertTime(Date.now())
        }

        // Update statistics
        setStats((prev) => ({
          ...prev,
          currentEAR: avgEAR,
          blinkRate: analysis.blinkRate,
          drowsinessScore: analysis.drowsinessScore,
          eyeClosureDuration: analysis.eyeClosureDuration,
          faceDetected: true,
          eyeAspectRatio: avgEAR,
          blinkCount:
            prev.blinkCount + (avgEAR < config.blinkThreshold && timestamp - lastBlinkRef.current > 200 ? 1 : 0),
          alertCount: prev.alertCount + (analysis.alertLevel !== "low" ? 1 : 0),
        }))

        updateAnalytics(
          avgEAR,
          analysis.drowsinessScore,
          analysis.alertLevel !== "low" ? analysis.alertLevel : undefined,
        )

        if (avgEAR < config.blinkThreshold && timestamp - lastBlinkRef.current > 200) {
          lastBlinkRef.current = timestamp
        }

        if (analysis.isDrowsy) {
          consecutiveDrowsyFramesRef.current++
          setDetectionStatus("drowsy")
        } else {
          consecutiveDrowsyFramesRef.current = 0
          setDetectionStatus("active")
        }
      } else {
        setStats((prev) => ({
          ...prev,
          faceDetected: false,
          eyeAspectRatio: 0,
          currentEAR: 0,
          blinkRate: 0,
          drowsinessScore: 0,
          eyeClosureDuration: 0,
        }))
        setDetectionStatus("active")
      }
    } catch (err) {
      console.error("[v0] Face detection error:", err)
    }

    // Continue detection loop
    animationRef.current = requestAnimationFrame(detectFaceAndEyes)
  }, [isStreaming, config, triggerAlert, updateAnalytics, alertState.level, lastAlertTime])

  const startCamera = async () => {
    try {
      setError(null)

      // Load model if not already loaded
      if (!modelLoaded && !isModelLoading) {
        await loadFaceDetectionModel()
      }

      if (!modelLoaded) {
        setError("Face detection model not loaded. Please wait and try again.")
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: "user",
        },
      })

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play()
        setIsStreaming(true)
        setDetectionStatus("active")

        startSession()

        // Start face detection after video is ready
        videoRef.current.onloadedmetadata = () => {
          detectFaceAndEyes()
        }
      }
    } catch (err) {
      setError("Failed to access camera. Please ensure camera permissions are granted.")
      console.error("Camera access error:", err)
    }
  }

  const stopCamera = () => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
    }

    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream
      stream.getTracks().forEach((track) => track.stop())
      videoRef.current.srcObject = null
    }
    setIsStreaming(false)
    setDetectionStatus("idle")

    endSession()

    // Clear canvas
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d")
      ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
    }
  }

  useEffect(() => {
    loadFaceDetectionModel()
  }, [loadFaceDetectionModel])

  useEffect(() => {
    return () => {
      stopCamera()
    }
  }, [])

  const updateEARThreshold = (value: number) => {
    setConfig((prev) => ({ ...prev, earThreshold: value }))
  }

  const updateSensitivity = (value: number) => {
    setConfig((prev) => ({ ...prev, consecutiveFrames: Math.round(value * 2) })) // 2-20 frames
  }

  const resetSettings = () => {
    setConfig({
      earThreshold: 0.25,
      consecutiveFrames: 10,
      blinkThreshold: 0.2,
      yawnThreshold: 0.6,
      alertCooldown: 3000,
    })

    // Reset detection history
    detectionHistoryRef.current = {
      earValues: [],
      blinkStates: [],
      timestamps: [],
      maxHistoryLength: 100,
      eyeClosureStartTime: null,
      lastEyeClosureDuration: 0,
    }

    setStats((prev) => ({
      ...prev,
      blinkCount: 0,
      alertCount: 0,
      blinkRate: 0,
      avgEAR: 0,
      drowsinessScore: 0,
      eyeClosureDuration: 0,
      currentEAR: 0,
    }))
  }

  const updateAlertConfig = (key: keyof AlertConfig, value: any) => {
    setAlertConfig((prev) => ({ ...prev, [key]: value }))
  }

  const testAlert = (level: AlertState["level"]) => {
    const messages = {
      low: "Test: Low level drowsiness alert",
      medium: "Test: Medium level drowsiness alert",
      high: "Test: High level drowsiness alert",
      critical: "Test: Critical drowsiness alert",
    }
    triggerAlert(level, messages[level])
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 p-4">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white">Real-Time Drowsiness Detection</h1>
          <p className="text-lg text-gray-600 dark:text-gray-300">
            Advanced AI-powered system for monitoring alertness and preventing fatigue-related incidents
          </p>
        </div>

        {alertState.isActive && alertConfig.visualEnabled && (
          <Alert
            variant="destructive"
            className={`border-2 ${
              alertState.level === "critical"
                ? "animate-pulse border-red-600 bg-red-50 dark:bg-red-950"
                : alertState.level === "high"
                  ? "border-orange-500 bg-orange-50 dark:bg-orange-950"
                  : alertState.level === "medium"
                    ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-950"
                    : "border-blue-500 bg-blue-50 dark:bg-blue-950"
            }`}
          >
            <AlertTriangle className="h-6 w-6" />
            <div className="flex-1">
              <div className="font-bold text-lg">{alertState.level.toUpperCase()} ALERT</div>
              <AlertDescription className="text-base">{alertState.message}</AlertDescription>
            </div>
            <Button onClick={dismissAlert} variant="outline" size="sm">
              Dismiss
            </Button>
          </Alert>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="detection" className="flex items-center space-x-2">
              <Camera className="w-4 h-4" />
              <span>Live Detection</span>
            </TabsTrigger>
            <TabsTrigger value="analytics" className="flex items-center space-x-2">
              <BarChart3 className="w-4 h-4" />
              <span>Analytics Dashboard</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="detection" className="space-y-6">
            {/* Status Bar */}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-4">
                    <div className="flex items-center space-x-2">
                      <div className={`w-3 h-3 rounded-full ${getStatusColor()}`}></div>
                      <span className="font-medium">{getStatusText()}</span>
                    </div>
                    <Badge variant={detectionStatus === "drowsy" ? "destructive" : "secondary"}>
                      {detectionStatus === "active"
                        ? "Monitoring"
                        : detectionStatus === "drowsy"
                          ? "Alert!"
                          : "Standby"}
                    </Badge>
                    {isModelLoading && <Badge variant="outline">Loading AI Model...</Badge>}
                    {modelLoaded && <Badge variant="outline">AI Model Ready</Badge>}
                    {stats.faceDetected && <Badge variant="outline">Face Detected</Badge>}
                    {stats.drowsinessScore > 50 && (
                      <Badge variant="destructive">Drowsiness: {stats.drowsinessScore.toFixed(0)}%</Badge>
                    )}
                    {alertConfig.audioEnabled && (
                      <Badge variant="outline">
                        <Volume2 className="w-3 h-3 mr-1" />
                        Audio
                      </Badge>
                    )}
                    {alertConfig.browserNotifications && notificationPermission === "granted" && (
                      <Badge variant="outline">
                        <Bell className="w-3 h-3 mr-1" />
                        Notifications
                      </Badge>
                    )}
                    {alertConfig.vibrationEnabled && "vibrate" in navigator && (
                      <Badge variant="outline">
                        <Smartphone className="w-3 h-3 mr-1" />
                        Vibration
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center space-x-6 text-sm text-gray-600 dark:text-gray-400">
                    <div className="flex items-center space-x-1">
                      <Eye className="w-4 h-4" />
                      <span>EAR: {stats.eyeAspectRatio.toFixed(3)}</span>
                    </div>
                    <div className="flex items-center space-x-1">
                      <Activity className="w-4 h-4" />
                      <span>Blinks: {stats.blinkCount}</span>
                    </div>
                    <div className="flex items-center space-x-1">
                      <AlertTriangle className="w-4 h-4" />
                      <span>Alerts: {stats.alertCount}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Video Feed */}
              <div className="lg:col-span-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <Camera className="w-5 h-5" />
                      <span>Live Camera Feed</span>
                    </CardTitle>
                    <CardDescription>Real-time video processing with face and eye detection overlay</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {error && (
                      <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    )}

                    <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
                      <video ref={videoRef} className="w-full h-full object-cover" autoPlay muted playsInline />
                      <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />
                      {!isStreaming && (
                        <div className="absolute inset-0 flex items-center justify-center text-white">
                          <div className="text-center space-y-2">
                            <CameraOff className="w-12 h-12 mx-auto opacity-50" />
                            <p className="text-sm opacity-75">Camera not active</p>
                            {isModelLoading && <p className="text-xs opacity-50">Loading AI model...</p>}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="flex space-x-2">
                      {!isStreaming ? (
                        <Button
                          onClick={startCamera}
                          disabled={isModelLoading || !modelLoaded}
                          className="flex items-center space-x-2"
                        >
                          <Camera className="w-4 h-4" />
                          <span>{isModelLoading ? "Loading Model..." : "Start Detection"}</span>
                        </Button>
                      ) : (
                        <Button onClick={stopCamera} variant="destructive" className="flex items-center space-x-2">
                          <CameraOff className="w-4 h-4" />
                          <span>Stop Detection</span>
                        </Button>
                      )}
                      {!isModelLoading && (
                        <Button onClick={loadFaceDetectionModel} variant="outline" size="sm">
                          Reload AI Model
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Control Panel */}
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Detection Settings</CardTitle>
                    <CardDescription>Configure drowsiness detection parameters</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">EAR Threshold</label>
                      <div className="flex items-center space-x-2">
                        <input
                          type="range"
                          min="0.15"
                          max="0.35"
                          step="0.01"
                          value={config.earThreshold}
                          onChange={(e) => updateEARThreshold(Number.parseFloat(e.target.value))}
                          className="flex-1"
                        />
                        <span className="text-sm text-gray-600 dark:text-gray-400 w-12">
                          {config.earThreshold.toFixed(2)}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">Alert Sensitivity</label>
                      <div className="flex items-center space-x-2">
                        <input
                          type="range"
                          min="1"
                          max="10"
                          step="1"
                          value={config.consecutiveFrames / 2}
                          onChange={(e) => updateSensitivity(Number.parseInt(e.target.value))}
                          className="flex-1"
                        />
                        <span className="text-sm text-gray-600 dark:text-gray-400 w-12">
                          {Math.round(config.consecutiveFrames / 2)}
                        </span>
                      </div>
                    </div>

                    <div className="pt-2">
                      <Button onClick={resetSettings} variant="outline" className="w-full bg-transparent">
                        Reset Settings
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Alert Settings</CardTitle>
                    <CardDescription>Configure alert notifications and sounds</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Volume2 className="w-4 h-4" />
                        <label className="text-sm font-medium">Audio Alerts</label>
                      </div>
                      <Switch
                        checked={alertConfig.audioEnabled}
                        onCheckedChange={(checked) => updateAlertConfig("audioEnabled", checked)}
                      />
                    </div>

                    {alertConfig.audioEnabled && (
                      <div className="space-y-2 ml-6">
                        <label className="text-sm font-medium">Volume</label>
                        <div className="flex items-center space-x-2">
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.1"
                            value={alertConfig.volume}
                            onChange={(e) => updateAlertConfig("volume", Number.parseFloat(e.target.value))}
                            className="flex-1"
                          />
                          <span className="text-sm text-gray-600 dark:text-gray-400 w-8">
                            {Math.round(alertConfig.volume * 100)}%
                          </span>
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Bell className="w-4 h-4" />
                        <label className="text-sm font-medium">Browser Notifications</label>
                      </div>
                      <Switch
                        checked={alertConfig.browserNotifications && notificationPermission === "granted"}
                        onCheckedChange={(checked) => {
                          if (checked && notificationPermission !== "granted") {
                            Notification.requestPermission().then((permission) => {
                              setNotificationPermission(permission)
                              updateAlertConfig("browserNotifications", permission === "granted")
                            })
                          } else {
                            updateAlertConfig("browserNotifications", checked)
                          }
                        }}
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Smartphone className="w-4 h-4" />
                        <label className="text-sm font-medium">Vibration (Mobile)</label>
                      </div>
                      <Switch
                        checked={alertConfig.vibrationEnabled && "vibrate" in navigator}
                        onCheckedChange={(checked) => updateAlertConfig("vibrationEnabled", checked)}
                        disabled={!("vibrate" in navigator)}
                      />
                    </div>

                    <div className="pt-2 space-y-2">
                      <label className="text-sm font-medium">Test Alerts</label>
                      <div className="grid grid-cols-2 gap-2">
                        <Button onClick={() => testAlert("low")} variant="outline" size="sm">
                          Low
                        </Button>
                        <Button onClick={() => testAlert("medium")} variant="outline" size="sm">
                          Medium
                        </Button>
                        <Button onClick={() => testAlert("high")} variant="outline" size="sm">
                          High
                        </Button>
                        <Button onClick={() => testAlert("critical")} variant="destructive" size="sm">
                          Critical
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>System Status</CardTitle>
                    <CardDescription>Real-time monitoring statistics</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="text-center p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                        <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stats.blinkCount}</div>
                        <div className="text-xs text-gray-600 dark:text-gray-400">Total Blinks</div>
                      </div>
                      <div className="text-center p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                        <div className="text-2xl font-bold text-red-600 dark:text-red-400">{stats.alertCount}</div>
                        <div className="text-xs text-gray-600 dark:text-gray-400">Drowsy Alerts</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="text-center p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                        <div className="text-lg font-bold text-purple-600 dark:text-purple-400">{stats.blinkRate}</div>
                        <div className="text-xs text-gray-600 dark:text-gray-400">Blinks/Min</div>
                      </div>
                      <div className="text-center p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                        <div className="text-lg font-bold text-orange-600 dark:text-orange-400">
                          {stats.drowsinessScore.toFixed(0)}%
                        </div>
                        <div className="text-xs text-gray-600 dark:text-gray-400">Drowsiness</div>
                      </div>
                    </div>

                    <div className="text-center p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                      <div
                        className={`text-lg font-bold ${stats.faceDetected ? "text-green-600 dark:text-green-400" : "text-gray-400"}`}
                      >
                        {stats.faceDetected ? "DETECTED" : "NO FACE"}
                      </div>
                      <div className="text-xs text-gray-600 dark:text-gray-400">Face Status</div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Eye Aspect Ratio</span>
                        <span className="font-mono">{stats.eyeAspectRatio.toFixed(3)}</span>
                      </div>
                      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full transition-all duration-300 ${
                            stats.eyeAspectRatio < config.earThreshold ? "bg-red-600" : "bg-blue-600"
                          }`}
                          style={{ width: `${Math.min(stats.eyeAspectRatio * 400, 100)}%` }}
                        ></div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Drowsiness Score</span>
                        <span className="font-mono">{stats.drowsinessScore.toFixed(1)}%</span>
                      </div>
                      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full transition-all duration-300 ${
                            stats.drowsinessScore > 70
                              ? "bg-red-600"
                              : stats.drowsinessScore > 40
                                ? "bg-yellow-600"
                                : "bg-green-600"
                          }`}
                          style={{ width: `${Math.min(stats.drowsinessScore, 100)}%` }}
                        ></div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="analytics" className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Analytics Dashboard</h2>
                <p className="text-gray-600 dark:text-gray-300">Monitor your alertness patterns and session history</p>
              </div>
              <Button
                onClick={exportSessionData}
                variant="outline"
                className="flex items-center space-x-2 bg-transparent"
              >
                <Download className="w-4 h-4" />
                <span>Export Data</span>
              </Button>
            </div>

            {/* Current Session Overview */}
            {analytics.currentSession && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Activity className="w-5 h-5" />
                    <span>Current Session</span>
                  </CardTitle>
                  <CardDescription>Live monitoring session in progress</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="text-center p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
                      <Clock className="w-6 h-6 mx-auto mb-2 text-blue-600" />
                      <div className="text-2xl font-bold text-blue-600">
                        {formatDuration(analytics.currentSession.duration)}
                      </div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Duration</div>
                    </div>
                    <div className="text-center p-4 bg-green-50 dark:bg-green-950 rounded-lg">
                      <Eye className="w-6 h-6 mx-auto mb-2 text-green-600" />
                      <div className="text-2xl font-bold text-green-600">{stats.blinkCount}</div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Blinks</div>
                    </div>
                    <div className="text-center p-4 bg-orange-50 dark:bg-orange-950 rounded-lg">
                      <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-orange-600" />
                      <div className="text-2xl font-bold text-orange-600">{stats.alertCount}</div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Alerts</div>
                    </div>
                    <div className="text-center p-4 bg-purple-50 dark:bg-purple-950 rounded-lg">
                      <TrendingUp className="w-6 h-6 mx-auto mb-2 text-purple-600" />
                      <div className="text-2xl font-bold text-purple-600">
                        {stats.eyeClosureDuration ? Math.round(stats.eyeClosureDuration / 1000) : 0}s
                      </div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Eye Closure Duration</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Real-time Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Eye Aspect Ratio Trend</CardTitle>
                  <CardDescription>Real-time EAR values over the last 5 minutes</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-64 flex items-end justify-between space-x-1">
                    {analytics.realTimeData.slice(-60).map((point, index) => (
                      <div
                        key={index}
                        className={`w-2 rounded-t transition-all duration-300 ${
                          point.ear < config.earThreshold ? "bg-red-500" : "bg-blue-500"
                        }`}
                        style={{ height: `${Math.max(point.ear * 400, 4)}px` }}
                        title={`EAR: ${point.ear.toFixed(3)} at ${new Date(point.timestamp).toLocaleTimeString()}`}
                      />
                    ))}
                  </div>
                  <div className="flex justify-between text-xs text-gray-500 mt-2">
                    <span>5 min ago</span>
                    <span>Now</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Drowsiness Score Trend</CardTitle>
                  <CardDescription>Real-time drowsiness levels over the last 5 minutes</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-64 flex items-end justify-between space-x-1">
                    {analytics.realTimeData.slice(-60).map((point, index) => (
                      <div
                        key={index}
                        className={`w-2 rounded-t transition-all duration-300 ${
                          point.drowsiness > 70
                            ? "bg-red-500"
                            : point.drowsiness > 40
                              ? "bg-yellow-500"
                              : "bg-green-500"
                        }`}
                        style={{ height: `${Math.max(point.drowsiness * 2.5, 4)}px` }}
                        title={`Drowsiness: ${point.drowsiness.toFixed(1)}% at ${new Date(point.timestamp).toLocaleTimeString()}`}
                      />
                    ))}
                  </div>
                  <div className="flex justify-between text-xs text-gray-500 mt-2">
                    <span>5 min ago</span>
                    <span>Now</span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Session History */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Calendar className="w-5 h-5" />
                  <span>Session History</span>
                </CardTitle>
                <CardDescription>Your recent monitoring sessions and performance</CardDescription>
              </CardHeader>
              <CardContent>
                {analytics.sessions.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <Calendar className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p>No completed sessions yet. Start monitoring to see your history.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {analytics.sessions.slice(0, 10).map((session) => {
                      const grade = getSessionGrade(session)
                      return (
                        <div
                          key={session.id}
                          className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg"
                        >
                          <div className="flex items-center space-x-4">
                            <div className="text-center">
                              <div className="text-sm text-gray-500">
                                {new Date(session.startTime).toLocaleDateString()}
                              </div>
                              <div className="text-xs text-gray-400">
                                {new Date(session.startTime).toLocaleTimeString()}
                              </div>
                            </div>
                            <div className="space-y-1">
                              <div className="flex items-center space-x-4 text-sm">
                                <span className="flex items-center space-x-1">
                                  <Clock className="w-3 h-3" />
                                  <span>{formatDuration(session.duration)}</span>
                                </span>
                                <span className="flex items-center space-x-1">
                                  <Eye className="w-3 h-3" />
                                  <span>{session.totalBlinks} blinks</span>
                                </span>
                                <span className="flex items-center space-x-1">
                                  <AlertTriangle className="w-3 h-3" />
                                  <span>{session.totalAlerts} alerts</span>
                                </span>
                              </div>
                              <div className="text-xs text-gray-500">
                                Max Drowsiness: {session.maxDrowsinessScore.toFixed(1)}% | Avg EAR:{" "}
                                {session.avgEAR.toFixed(3)}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className={`text-lg font-bold ${grade.color}`}>{grade.grade}</div>
                            <div className="text-xs text-gray-500">Performance</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Performance Insights */}
            {analytics.sessions.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Target className="w-5 h-5" />
                    <span>Performance Insights</span>
                  </CardTitle>
                  <CardDescription>Analysis of your alertness patterns and recommendations</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="text-center p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
                      <div className="text-2xl font-bold text-blue-600">
                        {(analytics.sessions.reduce((sum, s) => sum + s.duration, 0) / (1000 * 60 * 60)).toFixed(1)}h
                      </div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Total Monitoring Time</div>
                    </div>
                    <div className="text-center p-4 bg-green-50 dark:bg-green-950 rounded-lg">
                      <div className="text-2xl font-bold text-green-600">
                        {(analytics.sessions.reduce((sum, s) => sum + s.avgEAR, 0) / analytics.sessions.length).toFixed(
                          3,
                        )}
                      </div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Average EAR</div>
                    </div>
                    <div className="text-center p-4 bg-orange-50 dark:bg-orange-950 rounded-lg">
                      <div className="text-2xl font-bold text-orange-600">
                        {(
                          analytics.sessions.reduce((sum, s) => sum + s.totalAlerts, 0) / analytics.sessions.length
                        ).toFixed(1)}
                      </div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Avg Alerts/Session</div>
                    </div>
                  </div>

                  <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <h4 className="font-semibold mb-2">Recommendations</h4>
                    <ul className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
                      {analytics.sessions.some((s) => s.maxDrowsinessScore > 60) && (
                        <li>• Consider taking more frequent breaks during long monitoring sessions</li>
                      )}
                      {analytics.sessions.some((s) => s.totalAlerts > 5) && (
                        <li>• High alert frequency detected - ensure adequate rest before monitoring</li>
                      )}
                      {analytics.sessions.every((s) => s.maxDrowsinessScore < 30) && (
                        <li>• Excellent alertness maintained! Keep up the good work</li>
                      )}
                      <li>• Optimal monitoring sessions are typically 30-60 minutes with regular breaks</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )

  function getStatusColor() {
    switch (detectionStatus) {
      case "active":
        return "bg-green-500"
      case "drowsy":
        return "bg-red-500"
      default:
        return "bg-gray-500"
    }
  }

  function getStatusText() {
    switch (detectionStatus) {
      case "active":
        return "Alert & Active"
      case "drowsy":
        return "Drowsiness Detected"
      default:
        return "System Idle"
    }
  }
}
