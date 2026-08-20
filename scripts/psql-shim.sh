#!/bin/bash
# psql that runs inside the database container, for hosts that have docker but
# no postgres client. rebuild-delay-min.sh needs both psql and `docker service
# scale`, and those live in different places: the scale command only works on
# the swarm host, the client only exists in the container.
#
# Put this first on PATH as `psql` and the calling script needs no changes.
exec docker exec -i "$(docker ps -q -f name=dummrum-postgres | head -1)" \
	psql "$@"
