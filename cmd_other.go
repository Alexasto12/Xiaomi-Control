//go:build !windows

package main

import "os/exec"

func setCmdHideWindow(_ *exec.Cmd) {
}
