NAME := announcements
DEST ?= /srv/services/$(NAME)
SERVICE := $(NAME)
SYSTEMD_UNIT := /etc/systemd/system/$(SERVICE).service
# Usuario, grupo y binario del servicio: sobrescribibles al invocar make.
DEPLOY_USER ?= $(shell id -un)
DEPLOY_GROUP ?= $(shell id -gn)
DEPLOY_HOME ?= $(shell getent passwd $(DEPLOY_USER) | cut -d: -f6)
NODE_BIN ?= $(shell command -v node 2>/dev/null || echo /usr/bin/node)
# Fichero temporal donde se renderiza la unidad antes de instalarla.
RENDERED_UNIT := /tmp/$(SERVICE).service.render

.PHONY: build check typecheck test install deploy restart status logs

build:
	pnpm build

check: typecheck test build

typecheck:
	pnpm typecheck

test:
	pnpm test

# Instalacion inicial: prepara el destino e instala la unidad, tmpfiles y
# logrotate, pero no la habilita ni la arranca. El deploy la activa cuando ya
# existe el .env de produccion.
install:
	sudo install -d -o $(DEPLOY_USER) -g $(DEPLOY_GROUP) -m 0750 $(DEST) $(DEST)/dist $(DEST)/config
	rm -f $(RENDERED_UNIT)
	sed -e 's|@DEPLOY_USER@|$(DEPLOY_USER)|g' \
		-e 's|@DEPLOY_GROUP@|$(DEPLOY_GROUP)|g' \
		-e 's|@DEPLOY_HOME@|$(DEPLOY_HOME)|g' \
		-e 's|@DEST@|$(DEST)|g' \
		-e 's|@NODE_BIN@|$(NODE_BIN)|g' \
		deploy/$(SERVICE).service > $(RENDERED_UNIT)
	sudo install -m 0644 $(RENDERED_UNIT) $(SYSTEMD_UNIT)
	rm -f $(RENDERED_UNIT)
	sudo install -m 0644 deploy/$(SERVICE).tmpfiles.conf /etc/tmpfiles.d/$(SERVICE).conf
	sudo install -m 0644 deploy/$(SERVICE).logrotate.conf /etc/logrotate.d/$(SERVICE)
	sudo systemd-tmpfiles --create /etc/tmpfiles.d/$(SERVICE).conf
	sudo systemctl daemon-reload
	if test ! -f $(DEST)/config/guilds.json; then sudo install -o $(DEPLOY_USER) -g $(DEPLOY_GROUP) -m 0600 config/guilds.json $(DEST)/config/guilds.json; fi

# Solo sincroniza el bundle y manifiestos. Nunca copia el .env.
# Preserva config/guilds.json y exige secretos de produccion preparados aparte.
deploy: build
	test -f $(DEST)/.env || { echo "falta $(DEST)/.env; prepara los secretos de produccion antes del deploy"; exit 1; }
	test -f $(DEST)/config/guilds.json || { echo "falta $(DEST)/config/guilds.json; ejecuta make install o prepara la configuracion"; exit 1; }
	test -f $(SYSTEMD_UNIT) || { echo "falta $(SYSTEMD_UNIT); ejecuta make install"; exit 1; }
	test -d $(DEST)/dist || install -d -m 0750 $(DEST)/dist
	rsync -av --delete dist/ $(DEST)/dist/
	install -m 0644 package.json pnpm-lock.yaml pnpm-workspace.yaml $(DEST)/
	cd $(DEST) && pnpm install --prod --frozen-lockfile
	systemctl is-enabled --quiet $(SERVICE).service || sudo systemctl enable $(SERVICE).service
	sudo systemctl restart $(SERVICE).service
	systemctl is-active --quiet $(SERVICE).service

restart:
	sudo systemctl restart $(SERVICE).service

status:
	systemctl status $(SERVICE).service --no-pager

logs:
	journalctl -u $(SERVICE).service -n 50 -f
