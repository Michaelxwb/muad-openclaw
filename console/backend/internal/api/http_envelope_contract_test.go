package api

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestHTTPEncodersOnlyInResponseHelpers(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		contents, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, violation := range responseEncoderViolations(t, name, string(contents)) {
			t.Errorf("%s: json.NewEncoder must stay in response helpers", violation)
		}
	}
}

func TestHTTPEncoderContractAcceptsHelpersAndRejectsHandlers(t *testing.T) {
	cases := []struct {
		name, file, source string
		violations         int
	}{
		{"success helper", "server.go", "func writeJSON() { json.NewEncoder(nil) }", 0},
		{"error helper", "errors.go", "func writeErrorEnvelope() { json.NewEncoder(nil) }", 0},
		{"handler", "server.go", "func handleMe() { json.NewEncoder(nil) }", 1},
		{"helper name in wrong file", "other.go", "func writeJSON() { json.NewEncoder(nil) }", 1},
		{"method with helper name", "server.go", "type S struct{};func (*S) writeJSON() { json.NewEncoder(nil) }", 1},
		{"import alias", "server.go", "func handleMe() { j.NewEncoder(nil) }", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			imports := `import "encoding/json";`
			if tc.name == "import alias" {
				imports = `import j "encoding/json";`
			}
			got := responseEncoderViolations(t, tc.file, "package api;"+imports+tc.source)
			if len(got) != tc.violations {
				t.Fatalf("violations=%v; expected %d", got, tc.violations)
			}
		})
	}
}

func responseEncoderViolations(t *testing.T, name, source string) []string {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, name, source, 0)
	if err != nil {
		t.Fatal(err)
	}
	aliases := jsonImportAliases(file)
	var violations []string
	for _, decl := range file.Decls {
		fn, isFunction := decl.(*ast.FuncDecl)
		if isFunction && allowedEncoderHelper(name, fn) {
			continue
		}
		ast.Inspect(decl, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "NewEncoder" {
				return true
			}
			identifier, ok := selector.X.(*ast.Ident)
			if ok && aliases[identifier.Name] {
				violations = append(violations, fset.Position(selector.Pos()).String())
			}
			return true
		})
	}
	return violations
}

func jsonImportAliases(file *ast.File) map[string]bool {
	aliases := map[string]bool{}
	for _, item := range file.Imports {
		path, err := strconv.Unquote(item.Path.Value)
		if err != nil || path != "encoding/json" {
			continue
		}
		name := "json"
		if item.Name != nil {
			name = item.Name.Name
		}
		aliases[name] = true
	}
	return aliases
}

func allowedEncoderHelper(name string, fn *ast.FuncDecl) bool {
	if fn.Recv != nil {
		return false
	}
	return filepath.Base(name) == "server.go" && fn.Name.Name == "writeJSON" ||
		filepath.Base(name) == "errors.go" && fn.Name.Name == "writeErrorEnvelope"
}
