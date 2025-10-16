import { useCallback, useRef, useState } from 'react'

type Props = {
  accept?: string
  multiple?: boolean
  onFiles: (files: FileList | File[]) => void
  label?: string
}

export default function Dropzone({ accept = '.mp3,audio/mpeg', multiple = true, onFiles, label = 'ファイルをドロップまたは選択' }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFiles(e.dataTransfer.files)
      e.dataTransfer.clearData()
    }
  }, [onFiles])

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.currentTarget.files) onFiles(e.currentTarget.files)
  }, [onFiles])

  return (
    <div
      className={`rounded border-2 border-dashed p-6 text-center transition-colors ${dragOver ? 'border-blue-400 bg-blue-500/10' : 'border-gray-500/60 bg-white/5'}`}
      onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
      onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false) }}
      onDrop={onDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
      aria-label={label}
    >
      <p className="mb-3 text-sm opacity-80">{label}</p>
      <button
        type="button"
        className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 focus:outline-none"
        onClick={() => inputRef.current?.click()}
      >
        ファイルを選択
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={onChange}
      />
    </div>
  )
}
