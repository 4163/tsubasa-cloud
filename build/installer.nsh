; Keep the full product name ("Tsubasa~ Cloud") for the NSIS install directory instead of
; falling back to the lowercase package.json name ("tsubasa") due to the tilde filter.
!ifdef APP_FILENAME
  !undef APP_FILENAME
!endif
!define APP_FILENAME "${PRODUCT_FILENAME}"
