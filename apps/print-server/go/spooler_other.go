//go:build !windows

package main

import "fmt"

func sendSpooler(name string, data []byte) error {
	return fmt.Errorf("spooler printing (printer:%s) is Windows-only; use a network target (host:9100) here", name)
}

func listPrinters() ([]string, error) {
	return []string{}, fmt.Errorf("printer enumeration is Windows-only")
}
