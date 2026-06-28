//go:build prod

package web

import (
	"embed"
	"io/fs"
)

// dist holds the vite build output, copied into this directory by the image
// build before `go build -tags prod`.
//
//go:embed all:dist
var dist embed.FS

func assets() (fs.FS, bool) {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		return nil, false
	}
	return sub, true
}
