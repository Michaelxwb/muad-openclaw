package progress

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"
)

const version = "0.1.0"

type commandOptions struct {
	stage      string
	text       string
	skill      string
	id         string
	code       string
	visibility string
	privacy    string
	jsonOutput bool
	intervalMS int
	maxCount   int
}

func Run(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		printHelp(stdout)
		return ExitOK
	}
	if args[0] == "--version" || args[0] == "version" {
		fmt.Fprintf(stdout, "muad-progress %s\n", version)
		return ExitOK
	}
	switch args[0] {
	case "stage":
		return runEventCommand(TypeProgress, args[1:], stdout, stderr)
	case "done":
		return runEventCommand(TypeDone, args[1:], stdout, stderr)
	case "error":
		return runEventCommand(TypeError, args[1:], stdout, stderr)
	case "heartbeat":
		return runHeartbeat(args[1:], stdout, stderr)
	case "validate":
		return runValidate(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n", args[0])
		return ExitInvalidArgs
	}
}

func runEventCommand(eventType string, args []string, stdout io.Writer, stderr io.Writer) int {
	opts, err := parseEventFlags(eventType, args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return ExitInvalidArgs
	}
	event := newEvent(eventType, opts, time.Now())
	if err := validateEvent(event); err != nil {
		return writeValidationError(err, opts.jsonOutput, stdout, stderr)
	}
	if throttled, err := shouldThrottle(event, time.Now()); err != nil {
		fmt.Fprintf(stderr, "throttle state failed: %v\n", err)
	} else if throttled {
		event.Delivery = "throttled"
		_ = appendDiagnostic(event, "throttled")
		writeResult(stdout, opts.jsonOutput, Result{OK: true, Event: &event})
		return ExitOK
	}
	delivery, err := deliverEvent(event)
	event.Delivery = delivery
	if err != nil {
		if strictAdapter() {
			writeResult(stdout, opts.jsonOutput, Result{OK: false, Error: err.Error()})
			fmt.Fprintf(stderr, "adapter unavailable: %v\n", err)
			return ExitAdapterUnavailable
		}
		fmt.Fprintf(stderr, "adapter unavailable: %v\n", err)
	}
	writeResult(stdout, opts.jsonOutput, Result{OK: true, Event: &event})
	return ExitOK
}

func parseEventFlags(eventType string, args []string) (commandOptions, error) {
	fs := flag.NewFlagSet(eventType, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var opts commandOptions
	fs.StringVar(&opts.stage, "stage", "", "progress stage id")
	fs.StringVar(&opts.text, "text", "", "user-visible progress text")
	fs.StringVar(&opts.skill, "skill", "", "skill name")
	fs.StringVar(&opts.id, "id", "", "stable progress id")
	fs.StringVar(&opts.code, "code", "", "error code")
	fs.StringVar(&opts.visibility, "visibility", DefaultVisibility, "visibility")
	fs.StringVar(&opts.privacy, "privacy", DefaultPrivacy, "privacy")
	fs.BoolVar(&opts.jsonOutput, "json", false, "print JSON result")
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if eventType == TypeDone && opts.stage == "" {
		opts.stage = "done"
	}
	if eventType == TypeError && opts.stage == "" {
		opts.stage = "error"
	}
	return opts, nil
}

func runHeartbeat(args []string, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("heartbeat", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var opts commandOptions
	fs.StringVar(&opts.text, "text", "仍在处理中，请稍候", "heartbeat text")
	fs.StringVar(&opts.skill, "skill", "", "skill name")
	fs.StringVar(&opts.id, "id", "heartbeat", "stable progress id")
	fs.IntVar(&opts.intervalMS, "interval-ms", 10000, "heartbeat interval")
	fs.IntVar(&opts.maxCount, "max-count", 1, "max heartbeat count")
	fs.BoolVar(&opts.jsonOutput, "json", false, "print JSON result")
	if err := fs.Parse(args); err != nil {
		fmt.Fprintln(stderr, err)
		return ExitInvalidArgs
	}
	if opts.maxCount <= 0 {
		opts.maxCount = 1
	}
	if opts.intervalMS < 0 {
		opts.intervalMS = 0
	}
	event := newEvent(TypeProgress, commandOptions{
		stage:      "heartbeat",
		text:       opts.text,
		skill:      opts.skill,
		id:         opts.id,
		visibility: DefaultVisibility,
		privacy:    DefaultPrivacy,
	}, time.Now())
	if err := validateEvent(event); err != nil {
		return writeValidationError(err, opts.jsonOutput, stdout, stderr)
	}
	delivery, err := deliverEvent(event)
	event.Delivery = delivery
	if err != nil && strictAdapter() {
		writeResult(stdout, opts.jsonOutput, Result{OK: false, Error: err.Error()})
		return ExitAdapterUnavailable
	}
	writeResult(stdout, opts.jsonOutput, Result{OK: true, Event: &event})
	return ExitOK
}

func runValidate(args []string, stdout io.Writer, stderr io.Writer) int {
	opts, err := parseEventFlags("validate", args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return ExitInvalidArgs
	}
	if opts.stage == "" {
		opts.stage = "validate"
	}
	event := newEvent(TypeProgress, opts, time.Now())
	if err := validateEvent(event); err != nil {
		return writeValidationError(err, opts.jsonOutput, stdout, stderr)
	}
	writeResult(stdout, opts.jsonOutput, Result{OK: true, Event: &event})
	return ExitOK
}

func writeValidationError(err error, jsonOutput bool, stdout io.Writer, stderr io.Writer) int {
	if errors.Is(err, errSensitiveText) {
		writeResult(stdout, jsonOutput, Result{OK: false, Error: err.Error()})
		fmt.Fprintln(stderr, err)
		return ExitSensitiveRejected
	}
	writeResult(stdout, jsonOutput, Result{OK: false, Error: err.Error()})
	fmt.Fprintln(stderr, err)
	return ExitInvalidArgs
}

func writeResult(stdout io.Writer, jsonOutput bool, result Result) {
	if jsonOutput {
		writeJSONResult(stdout, result)
		return
	}
	if result.OK {
		if result.Event != nil {
			fmt.Fprintf(stdout, "%s: %s\n", result.Event.Type, result.Event.Text)
		}
		return
	}
	if strings.TrimSpace(result.Error) != "" {
		fmt.Fprintf(stdout, "error: %s\n", result.Error)
	}
}

func printHelp(stdout io.Writer) {
	fmt.Fprintln(stdout, `muad-progress reports user-visible skill progress.

Usage:
  muad-progress stage --stage <id> --text <text> [--skill <name>] [--id <id>] [--json]
  muad-progress done --text <text> [--skill <name>] [--json]
  muad-progress error --stage <id> --text <text> [--code <code>] [--json]
  muad-progress heartbeat [--text <text>] [--interval-ms <ms>] [--max-count <n>]
  muad-progress validate --stage <id> --text <text> [--json]

Environment:
  MUAD_PROGRESS_ADAPTER_CMD     adapter command that receives event JSON on stdin
  MUAD_PROGRESS_STATE_DIR       state and diagnostic directory
  MUAD_PROGRESS_STRICT_ADAPTER  fail when adapter is unavailable
  MUAD_SKILL_NAME               default skill name`)
}
