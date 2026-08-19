/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IMGBB_API_KEY: string
  readonly VITE_IMG_UPLOAD_FORMAT: string
  readonly VITE_IMG_UPLOAD_QUALITY: string
  readonly VITE_ANIM_FADE: string
  readonly VITE_ANIM_RETRACK: string
  /** roughly 5 seconds per 4 loops */
  readonly VITE_ANIM_OWL_FLY_LOOPS: string
  readonly VITE_PHOTO_COUNTDOWN: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
