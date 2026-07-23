GCLOUD ?= gcloud
DAEMON_HOST ?= linear-agent
DAEMON_PROJECT ?= bloom-agents
DAEMON_ZONE ?= us-central1-a
DAEMONCTL ?= /usr/local/sbin/daemonctl

# Capture command-line variables without expanding embedded Make or shell syntax. The
# Python transport parses ARGS and creates both the local gcloud argv and remote command.
override DAEMON_REMOTE_GCLOUD := $(value GCLOUD)
override DAEMON_REMOTE_HOST := $(value DAEMON_HOST)
override DAEMON_REMOTE_PROJECT := $(value DAEMON_PROJECT)
override DAEMON_REMOTE_ZONE := $(value DAEMON_ZONE)
override DAEMON_REMOTE_DAEMONCTL := $(value DAEMONCTL)
override DAEMON_REMOTE_ARGS := $(value ARGS)
override DAEMON_REMOTE_PLANNER := $(value PLANNER)
override DAEMON_REMOTE_IMPLEMENTER := $(value IMPLEMENTER)
export DAEMON_REMOTE_GCLOUD DAEMON_REMOTE_HOST DAEMON_REMOTE_PROJECT DAEMON_REMOTE_ZONE
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
