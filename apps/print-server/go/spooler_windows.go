//go:build windows

package main

import (
	"fmt"

	"github.com/alexbrainman/printer"
)

// sendSpooler writes RAW bytes to an installed Windows printer by display name.
func sendSpooler(name string, data []byte) error {
	p, err := printer.Open(name)
	if err != nil {
		return fmt.Errorf("open printer %q: %w", name, err)
	}
	defer p.Close()
	if err := p.StartRawDocument("SwiftPOS Receipt"); err != nil {
		return fmt.Errorf("start doc: %w", err)
	}
	defer p.EndDocument()
	if _, err := p.Write(data); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

// listPrinters returns installed Windows printer names for the dashboard dropdown.
func listPrinters() ([]string, error) {
	return printer.ReadNames()
}
