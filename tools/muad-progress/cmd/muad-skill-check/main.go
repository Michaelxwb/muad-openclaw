package main

import (
	"os"

	"github.com/Michaelxwb/muad-openclaw/tools/muad-progress/internal/skillcheck"
)

func main() {
	os.Exit(skillcheck.Run(os.Args[1:], os.Stdout, os.Stderr))
}
