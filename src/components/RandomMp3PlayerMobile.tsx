import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Dropzone from './Dropzone'

type Track = { name: string; url: string }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function pickRandom<T>(items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined
  const idx = Math.floor(Math.random() * items.length)
  return items[idx]
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function createWavSilence(seconds: number): Blob {
  const sampleRate = 44100
  const numChannels = 1
  const bitsPerSample = 16
  const frameCount = Math.max(0, Math.floor(seconds * sampleRate))

  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const dataSize = frameCount * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  let offset = 0
  function writeString(s: string) {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
    offset += s.length
  }
  function writeUint32(v: number) {
    view.setUint32(offset, v, true)
    offset += 4
  }
  function writeUint16(v: number) {
    view.setUint16(offset, v, true)
    offset += 2
  }

  // RIFF header
  writeString('RIFF')
  writeUint32(36 + dataSize) // chunk size
  writeString('WAVE')

  // fmt subchunk
  writeString('fmt ')
  writeUint32(16) // PCM
  writeUint16(1) // audio format = PCM
  writeUint16(numChannels)
  writeUint32(sampleRate)
  writeUint32(byteRate)
  writeUint16(blockAlign)
  writeUint16(bitsPerSample)

  // data subchunk
  writeString('data')
  writeUint32(dataSize)

  // samples (silence = 0)
  // 16-bit PCM mono → Int16 little-endian zeros
  for (let i = 0; i < frameCount; i++) {
    view.setInt16(44 + i * 2, 0, true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

export function makeSilenceWavUrl(seconds: number): string {
  const s = clamp(seconds, 0, 3600)
  const blob = createWavSilence(s)
  return URL.createObjectURL(blob)
}

type PlayOptions = {
  revokeOnEnd?: boolean
  title?: string
}

export default function RandomMp3PlayerMobile() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [running, setRunning] = useState(false)
  const [minGapSec, setMinGapSec] = useState(3)
  const [maxGapSec, setMaxGapSec] = useState(10)
  const [volume, setVolume] = useState(1)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const currentIsSilenceRef = useRef<boolean>(false)
  const pendingRevokeRef = useRef<string | null>(null)
  const currentMusicUrlRef = useRef<string | null>(null)
  const lastPlayedUrlRef = useRef<string | null>(null)
  const [currentTitle, setCurrentTitle] = useState('')
  const [silenceRemainingMs, setSilenceRemainingMs] = useState(0)
  const silenceStartRef = useRef<number>(0)
  const silenceDurRef = useRef<number>(0)
  const rafRef = useRef<number | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [showGlitch, setShowGlitch] = useState(false)

  const canStart = useMemo(() => tracks.length > 0 && !running, [tracks.length, running])

  const cleanupPendingRevoke = useCallback(() => {
    const url = pendingRevokeRef.current
    if (url) {
      URL.revokeObjectURL(url)
      pendingRevokeRef.current = null
    }
  }, [])

  const setMediaMetadata = useCallback((title: string) => {
    if ('mediaSession' in navigator) {
      try {
        (navigator as any).mediaSession.metadata = new (window as any).MediaMetadata({
          title,
          artist: 'Random Player',
        })
      } catch {}
    }
  }, [])

  const attachMediaHandlers = useCallback(() => {
    if (!('mediaSession' in navigator)) return
    const ms = (navigator as any).mediaSession
    const safe = (type: string, handler: (() => void) | null) => {
      try {
        ms.setActionHandler(type, handler)
      } catch {}
    }
    safe('play', () => {
      if (!running) setRunning(true)
      audioRef.current?.play().catch(() => setRunning(false))
    })
    safe('pause', () => {
      audioRef.current?.pause()
      setRunning(false)
    })
    safe('nexttrack', () => {
      // Skip current and go to silence→next track
      if (!audioRef.current) return
      audioRef.current.pause()
      if (currentIsSilenceRef.current) {
        // if currently silence, jump to next track immediately
        playRandomTrack()
      } else {
        playSilenceThenNext()
      }
    })
    safe('previoustrack', () => {
      // No real previous; emulate by triggering silence→next
      if (!audioRef.current) return
      audioRef.current.pause()
      playSilenceThenNext()
    })
  }, [running])

  const playSrc = useCallback(async (url: string, opts: PlayOptions = {}) => {
    const audio = audioRef.current
    if (!audio) return

    cleanupPendingRevoke()
    audio.src = url
    audio.volume = volume
    audio.preload = 'auto'
    // iOS向け: audio要素でもplaysinline属性を付与（無害）
    audio.setAttribute('playsinline', '')
    try {
      await audio.play()
      // 音楽再生開始時にグリッチエフェクトを表示
      if (!opts.title?.includes('Silence')) {
        setShowGlitch(true)
        setTimeout(() => setShowGlitch(false), 2000) // 2秒後に停止
      }
    } catch (e) {
      // Interruption or autoplay policy; stop running and surface to UI
      setRunning(false)
      return
    }
    if (opts.revokeOnEnd) {
      pendingRevokeRef.current = url
    }
    if (opts.title) {
      setCurrentTitle(opts.title)
      setMediaMetadata(opts.title)
    }
  }, [cleanupPendingRevoke, setMediaMetadata, volume])

  const playRandomTrack = useCallback(() => {
    if (tracks.length === 0) return
    const lastUrl = lastPlayedUrlRef.current
    let pool = tracks
    if (lastUrl && tracks.length > 1) {
      pool = tracks.filter(tr => tr.url !== lastUrl)
    }
    const t = pickRandom(pool)
    if (!t) return
    currentIsSilenceRef.current = false
    currentMusicUrlRef.current = t.url
    lastPlayedUrlRef.current = t.url
    void playSrc(t.url, { revokeOnEnd: false, title: t.name })
  }, [tracks, playSrc])

  const playSilenceThenNext = useCallback(() => {
    const lo = Math.min(minGapSec, maxGapSec)
    const hi = Math.max(minGapSec, maxGapSec)
    const dur = clamp(lo + Math.random() * (hi - lo), 0, 3600)
    const silenceUrl = makeSilenceWavUrl(dur)
    currentIsSilenceRef.current = true
    currentMusicUrlRef.current = null
    // カウントダウン開始
    silenceStartRef.current = performance.now()
    silenceDurRef.current = dur * 1000
    setSilenceRemainingMs(silenceDurRef.current)
    const tick = () => {
      const elapsed = performance.now() - silenceStartRef.current
      const remain = Math.max(0, silenceDurRef.current - elapsed)
      setSilenceRemainingMs(remain)
      if (remain > 0 && currentIsSilenceRef.current && running) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
      }
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)
    void playSrc(silenceUrl, { revokeOnEnd: true, title: `Silence ${dur.toFixed(1)}s` })
  }, [minGapSec, maxGapSec, playSrc, running])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onEnded = () => {
      if (!running) return
      if (currentIsSilenceRef.current) {
        setSilenceRemainingMs(0)
        playRandomTrack()
      } else {
        playSilenceThenNext()
      }
    }

    const onTimeUpdate = () => {
      if (!currentIsSilenceRef.current) {
        setCurrentTime(audio.currentTime)
        setDuration(audio.duration || 0)
      }
    }

    const onLoadedMetadata = () => {
      setDuration(audio.duration || 0)
    }

    audio.addEventListener('ended', onEnded)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)

    return () => {
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
    }
  }, [running, playRandomTrack, playSilenceThenNext])

  useEffect(() => {
    const audio = audioRef.current
    if (audio) audio.volume = volume
  }, [volume])

  useEffect(() => {
    attachMediaHandlers()
  }, [attachMediaHandlers])

  const onStart = useCallback(async () => {
    if (running || tracks.length === 0) return
    setRunning(true)
    // Start must call play() synchronously after user gesture
    const audio = audioRef.current
    if (!audio) return
    // 最初の再生時は待機時間なしで即座に再生開始
    playRandomTrack()
  }, [running, tracks.length, playRandomTrack])

  const onStop = useCallback(() => {
    setRunning(false)
    const audio = audioRef.current
    audio?.pause()
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setSilenceRemainingMs(0)
    setCurrentTime(0)
    setDuration(0)
  }, [])

  const onFiles = useCallback((files: FileList | File[] | null) => {
    if (!files || (Array.isArray(files) ? files.length === 0 : files.length === 0)) {
      return
    }

    const list = Array.isArray(files) ? files : Array.from(files)
    const newTracks: Track[] = []

    for (const f of list) {
      // 重複チェック（同じファイル名の場合はスキップ）
      const isDuplicate = tracks.some(track => track.name === f.name)
      if (!isDuplicate) {
        const url = URL.createObjectURL(f)
        newTracks.push({ name: f.name, url })
      }
    }

    // 既存のトラックに新しいトラックを追加
    setTracks(prev => [...prev, ...newTracks])
  }, [tracks])

  const clearFiles = useCallback(() => {
    // 既存のObject URLsを解放
    setTracks(prev => {
      for (const t of prev) URL.revokeObjectURL(t.url)
      return []
    })
    lastPlayedUrlRef.current = null
    setRunning(false)
    const audio = audioRef.current
    audio?.pause()
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setSilenceRemainingMs(0)
  }, [])

  const skipTrack = useCallback(() => {
    if (!running || !audioRef.current) return
    // 現在の曲を停止して次の曲へ
    audioRef.current.pause()
    if (currentIsSilenceRef.current) {
      // 現在サイレンス中なら即座に次の曲へ
      playRandomTrack()
    } else {
      // 音楽再生中ならサイレンス→次の曲へ
      playSilenceThenNext()
    }
  }, [running, playRandomTrack, playSilenceThenNext])

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      cleanupPendingRevoke()
      if (currentMusicUrlRef.current) {
        // music urls are file object urls, revoke when leaving component
        // Note: current track may be in audio.src; safe to revoke on teardown
        URL.revokeObjectURL(currentMusicUrlRef.current)
        currentMusicUrlRef.current = null
      }
      setTracks(prev => {
        for (const t of prev) URL.revokeObjectURL(t.url)
        return []
      })
    }
  }, [cleanupPendingRevoke])

  return (
    <div className="mx-auto max-w-sm p-4 space-y-6">
      {/* ヘッダーセクション */}
      <div className="text-center space-y-3">
        <div className={`glitch-container ${showGlitch ? 'glitch-effect' : ''}`} data-text="Random MP3 Player">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
            Random MP3 Player
          </h1>
        </div>
        <p className="text-sm text-gray-400">音楽をランダムに楽しもう</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-gray-300">MP3 ファイル選択</label>
          {tracks.length > 0 && (
            <button
              onClick={clearFiles}
              className="rounded-md bg-red-600/20 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-600/30 hover:text-red-300 transition-all focus:outline-none focus:ring-2 focus:ring-red-500/50"
              aria-label="ファイルをクリア"
            >
              <svg className="w-3 h-3 inline mr-1" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
              クリア
            </button>
          )}
        </div>
        <Dropzone accept=".mp3,audio/mpeg" multiple onFiles={onFiles} label="ここにドラッグ＆ドロップ、またはクリックして選択" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-300">最小待ち秒</label>
          <input
            type="number"
            min={0}
            max={3600}
            value={minGapSec}
            onChange={(e) => setMinGapSec(clamp(Number(e.target.value), 0, 3600))}
            className="w-full rounded-lg border border-gray-600 bg-gray-800 p-3 text-white focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
            inputMode="numeric"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-300">最大待ち秒</label>
          <input
            type="number"
            min={0}
            max={3600}
            value={maxGapSec}
            onChange={(e) => setMaxGapSec(clamp(Number(e.target.value), 0, 3600))}
            className="w-full rounded-lg border border-gray-600 bg-gray-800 p-3 text-white focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
            inputMode="numeric"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300">音量: {Math.round(volume * 100)}%</label>
        <div className="mt-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(clamp(Number(e.target.value), 0, 1))}
            className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer slider"
            aria-label="Volume"
          />
        </div>
      </div>

      <div className="flex gap-3">
        <button
          className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-green-500 to-green-600 px-6 py-3 font-semibold text-white shadow-lg hover:from-green-400 hover:to-green-500 disabled:opacity-50 disabled:hover:from-green-500 disabled:hover:to-green-600 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-green-500/50 transition-all transform hover:scale-105 disabled:hover:scale-100"
          onClick={onStart}
          disabled={!canStart}
          aria-label="Start"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
          </svg>
          Start
        </button>
        {running && (
          <button
            onClick={skipTrack}
            className="flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-3 font-semibold text-white shadow-lg hover:from-blue-400 hover:to-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all transform hover:scale-105"
            aria-label="Skip"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 15.707a1 1 0 010-1.414L8.586 10 4.293 5.707a1 1 0 011.414-1.414l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0zM11.293 15.707a1 1 0 010-1.414L15.586 10l-4.293-4.293a1 1 0 011.414-1.414l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          </button>
        )}
        <button
          className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-gray-600 to-gray-700 px-6 py-3 font-semibold text-white shadow-lg hover:from-gray-500 hover:to-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500/50 transition-all transform hover:scale-105"
          onClick={onStop}
          aria-label="Stop"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          Stop
        </button>
      </div>

      <div className="bg-gray-800/50 rounded-lg p-4 space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse"></div>
          <span className="text-sm font-medium text-gray-300">現在: {currentTitle || '—'}</span>
          {running && !currentIsSilenceRef.current && (
            <div className="audio-wave ml-2">
              <div className="audio-wave-bar"></div>
              <div className="audio-wave-bar"></div>
              <div className="audio-wave-bar"></div>
              <div className="audio-wave-bar"></div>
              <div className="audio-wave-bar"></div>
            </div>
          )}
        </div>
        {running && !currentIsSilenceRef.current && duration > 0 && (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
            <span className="text-sm text-gray-400">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>
        )}
        {running && silenceRemainingMs > 0 && (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-orange-400 rounded-full animate-pulse"></div>
            <span className="text-sm text-gray-400">次の再生まで: {(silenceRemainingMs / 1000).toFixed(1)} 秒</span>
          </div>
        )}
      </div>

      <details open className="bg-gray-800/30 rounded-lg">
        <summary className="cursor-pointer p-4 text-sm font-medium text-gray-300 hover:text-white transition-colors">
          選択中の曲 ({tracks.length})
        </summary>
        <div className="px-4 pb-4">
          <ul className="space-y-2">
            {tracks.map(t => {
              const isCurrent = currentMusicUrlRef.current === t.url && running && !currentIsSilenceRef.current
              return (
                <li key={t.url} className={`flex items-center gap-2 text-sm p-2 rounded transition-colors ${
                  isCurrent
                    ? 'bg-green-500/20 text-green-400 font-semibold'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
                }`}>
                  <div className={`w-2 h-2 rounded-full ${isCurrent ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`}></div>
                  <span className="truncate">{t.name}</span>
                  {isCurrent && <span className="text-xs text-green-300">（再生中）</span>}
                </li>
              )
            })}
          </ul>
        </div>
      </details>

      {/* Hidden audio element used for playback control */}
      <audio ref={audioRef} preload="auto" playsInline />
    </div>
  )
}
