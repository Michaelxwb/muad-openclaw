package main

import (
	"os"

	"github.com/Michaelxwb/muad-openclaw/tools/muad-progress/internal/progress"
)

func main() {
	os.Exit(progress.Run(os.Args[1:], os.Stdout, os.Stderr))
}
