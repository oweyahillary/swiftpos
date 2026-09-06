//go:build !windows

package main

import "fmt"

func sendSpooler(name string, data []byte) error {
	return fmt.Errorf("spooler printing (printer:%s) is only supported on Windows; use a network (host:9100) or share target here", name)
}
