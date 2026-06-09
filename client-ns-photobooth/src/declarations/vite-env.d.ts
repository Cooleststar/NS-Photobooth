/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLOUDINARY_NAME: string
  readonly VITE_CLOUDINARY_PRESET: string
  readonly VITE_IMG_UPLOAD_FORMAT: string
  readonly VITE_IMG_UPLOAD_QUALITY: string
  readonly VITE_ANIM_FADE: string
  readonly VITE_ANIM_RETRACK: string
  /** roughly 5 seconds per 4 loops */
  readonly VITE_ANIM_OWL_FLY_LOOPS: string
  readonly VITE_PHOTO_COUNTDOWN: string
  readonly VITE_LANDING_PAGE_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
