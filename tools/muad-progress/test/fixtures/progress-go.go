package main

import (
	"fmt"
	"os"
	"os/exec"
)

func main() {
	command := exec.Command(
		"muad-progress", "done", "--stage", "query",
		"--text", "四语言一致 ✅\nMarkdown **bold**",
		"--id", "cross-language", "--skill", "fixture-skill",
	)
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "progress command failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(`{"ok":true,"language":"go"}`)
}
