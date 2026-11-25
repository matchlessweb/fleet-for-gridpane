#!/bin/bash
# ==============================================================================
# Take the DEFINER out of a database export before it is loaded elsewhere
# ==============================================================================
# Sourced by fleet-site-final-copy.sh and its self-test. Not executable on its own.
#
# WHY: mysqldump writes each view, trigger and routine with the account that made
# it on the old server (DEFINER=`old_user`@`localhost`). A site's export is loaded
# on the new server as that site's own database user, and MySQL refuses to create
# an object for a different account unless the loader has SUPER or SET_ANY_DEFINER
# (ERROR 1227). The load stops at the first one. Views come last in an export, so
# every table loads and only the views go missing, which is easy to miss.
#
# THE FIX: drop the DEFINER clause. MySQL then makes the loading user the definer,
# which on the new server is the site's own database user: the right owner there.
# A view's SQL SECURITY (INVOKER or DEFINER) is kept as it was.
#
# The three forms mysqldump writes (5.7, 8.0, 8.4, and Percona builds of them):
#   view     /*!50013 DEFINER=`u`@`h` SQL SECURITY INVOKER */
#   trigger  /*!50017 DEFINER=`u`@`h`*/
#   routine  /*!50020 DEFINER=`u`@`h`*/   (and events; only with --routines/--events)
#
# Sets:
#   FLEET_SQL_DEFINER_SED   sed -E program (GNU and BSD sed) that removes them
#   FLEET_SQL_DEFINER_LEFT  grep -E pattern; any match after the sed means one was missed
# ==============================================================================
# shellcheck disable=SC2034  # read by the scripts that source this file
FLEET_SQL_DEFINER_SED='s#(/\*!50013) DEFINER=[^ ]+ (SQL SECURITY [A-Z]+ \*/)#\1 \2#g; s#/\*!500(17|20) DEFINER=[^ ]+ ?\*/ ?##g'
FLEET_SQL_DEFINER_LEFT='/\*!50[0-9]{3} DEFINER='
