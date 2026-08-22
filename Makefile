DAEMON_SSH ?= ssh
DAEMON_SSH_HOST ?= bloomi
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

REMOTE_DAEMONCTL := python3 daemon/ops/daemonctl-remote.py

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
