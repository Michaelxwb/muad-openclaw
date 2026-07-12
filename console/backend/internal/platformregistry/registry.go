// Package platformregistry lists adapters compiled into the worker image.
package platformregistry

import "slices"

var installed = []string{"mssw", "sdsp", "sea_soar", "soar", "xdr"}

func Supports(platform string) bool {
	_, found := slices.BinarySearch(installed, platform)
	return found
}

func Installed() []string {
	return append([]string(nil), installed...)
}
