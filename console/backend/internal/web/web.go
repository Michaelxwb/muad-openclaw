// Package web serves the embedded frontend SPA. The actual assets are provided
// by build-tagged files: with `-tags prod` the vite build output is embedded;
// without it (dev) no assets are served and the vite dev server is used instead.
package web

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// Handler returns an SPA handler over the embedded assets, or (nil,false) when
// no assets are embedded (dev build).
func Handler() (http.Handler, bool) {
	fsys, ok := assets()
	if !ok {
		return nil, false
	}
	return spa{fsys}, true
}

type spa struct{ fsys fs.FS }

// ServeHTTP serves static files, falling back to index.html for client-side
// routes (single-page app).
func (h spa) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p == "" {
		p = "index.html"
	}
	if _, err := fs.Stat(h.fsys, p); err != nil {
		p = "index.html"
	}
	http.ServeFileFS(w, r, h.fsys, p)
}
