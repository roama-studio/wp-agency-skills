<?php
/**
 * Agency bridge export: removes the job and its private folder when the plugin is deleted.
 *
 * @package AgencyBridge
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}
require_once __DIR__ . '/includes/class-agency-bridge-export.php';
Agency_Bridge_Export::cleanup();
wp_clear_scheduled_hook( 'agency_bridge_export_cleanup' );
