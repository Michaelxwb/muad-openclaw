//go:build !prod

package web

import "io/fs"

// assets returns no embedded FS in dev builds; the vite dev server serves the UI.
func assets() (fs.FS, bool) { return nil, false }
