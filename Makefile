DAEMON_SSH ?= ssh
# SSH alias for the daemon's service account on the production host. Set it
# per invocation or export it in your shell; it is deployment-specific and has
# no default here.
DAEMON_SSH_HOST ?=
DAEMONCTL ?= /usr/local/sbin/daemonctl

# Capture command-line variables without expanding embedded Make or shell syntax. The
# Python transport parses ARGS and creates both the local ssh argv and remote command.
override DAEMON_REMOTE_SSH := $(value DAEMON_SSH)
override DAEMON_REMOTE_HOST := $(value DAEMON_SSH_HOST)
override DAEMON_REMOTE_DAEMONCTL := $(value DAEMONCTL)
override DAEMON_REMOTE_ARGS := $(value ARGS)
override DAEMON_REMOTE_PLANNER := $(value PLANNER)
override DAEMON_REMOTE_IMPLEMENTER := $(value IMPLEMENTER)
export DAEMON_REMOTE_SSH DAEMON_REMOTE_HOST
export DAEMON_REMOTE_DAEMONCTL DAEMON_REMOTE_ARGS
export DAEMON_REMOTE_PLANNER DAEMON_REMOTE_IMPLEMENTER

REMOTE_DAEMONCTL := $(if $(DAEMON_SSH_HOST),,$(error DAEMON_SSH_HOST is required: the SSH alias for the daemon service account))python3 daemon/ops/daemonctl-remote.py

.PHONY: daemon-status daemon-sessions daemon-top daemon-restart daemon-hard-restart daemon-config daemon-reload daemon-update daemon-subscriptions

daemon-status:
	$(REMOTE_DAEMONCTL) status

daemon-sessions:
	$(REMOTE_DAEMONCTL) sessions

daemon-top:
	$(REMOTE_DAEMONCTL) top

daemon-restart:
	$(REMOTE_DAEMONCTL) restart

daemon-hard-restart:
	$(REMOTE_DAEMONCTL) hard-restart

daemon-config:
	$(REMOTE_DAEMONCTL) config

daemon-reload:
	$(REMOTE_DAEMONCTL) reload

daemon-update:
	$(REMOTE_DAEMONCTL) update

daemon-subscriptions:
	$(REMOTE_DAEMONCTL) subscriptions
