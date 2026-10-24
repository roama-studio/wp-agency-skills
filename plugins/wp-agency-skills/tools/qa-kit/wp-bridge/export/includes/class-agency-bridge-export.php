<?php
/**
 * Agency bridge: the export job.
 *
 * Builds one zip of the site for `qa-kit wp-site import`: database.sql (a MySQL dump of
 * every table of this site, made through $wpdb) + files/ (the WordPress folder without
 * wp-config.php, caches, backups and archives) + export.json (facts). Works in short
 * steps (each AJAX call runs a few seconds) so shared-hosting time and memory limits
 * hold; the job state lives in a non-autoloaded option, the work in a private folder in
 * uploads (random name, closed to the web) that is removed after the download, after
 * 24 hours, or when the plugin is deactivated.
 *
 * @package AgencyBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! class_exists( 'Agency_Bridge_Export' ) ) :

	/**
	 * The export job: start, step, download, cleanup.
	 */
	class Agency_Bridge_Export {

		const JOB_OPTION = 'agency_bridge_export_job';
		const FORMAT     = 'agency-export/1';
		const TTL        = DAY_IN_SECONDS;
		const ROWS       = 500;                 // rows per SELECT
		const INSERT_MAX = 524288;              // bytes per INSERT statement
		const FILE_MAX   = 268435456;           // files over 256 MB are left out (listed)

		// Left out (relative to the WordPress folder): the client's config, git, caches,
		// backups, logs and archives - the same idea as qa-kit wp-site's skipCopy.
		const SKIP_DIRS  = '#^(\.git|\.svn|node_modules|wp-content/(cache|upgrade|upgrade-temp-backup|updraft|ai1wm-backups|backups[\w-]*|backup[\w-]*|wpvivid\w*|backwpup[\w-]*|et-cache|litespeed|w3tc-config|wflogs|uploads/(backwpup[\w-]*|wpo-cache|cache|ai1wm-backups|agency-bridge-[a-f0-9]+|wp-migrate-db|wp-file-manager-pro)))$#i';
		const SKIP_FILES = '#(^wp-config\.php$|(^|/)\.env(\..*)?$|^wp-config-backup.*\.php$|^wp-content/debug\.log$|\.(zip|tar|gz|tgz|bz2|rar|7z|sql|wpress|bak|log|daf|jpa)$|^error_log$|/error_log$)#i';

		/** The running / finished job, or null. */
		public static function job() {
			$job = get_option( self::JOB_OPTION );
			return is_array( $job ) ? $job : null;
		}

		private static function save( array $job ) {
			if ( false === get_option( self::JOB_OPTION, false ) ) {
				add_option( self::JOB_OPTION, $job, '', 'no' );
			} else {
				update_option( self::JOB_OPTION, $job, false );
			}
		}

		/** A new job: private folder, the table list, an empty dump. */
		public static function start() {
			global $wpdb;
			self::cleanup();
			$uploads = wp_upload_dir(); // Creates uploads/ on a site that has never had a file.
			if ( ! empty( $uploads['error'] ) || ! wp_mkdir_p( $uploads['basedir'] ) || ! wp_is_writable( $uploads['basedir'] ) ) {
				throw new RuntimeException( 'папка uploads недоступна для запису' );
			}
			$dir = $uploads['basedir'] . '/agency-bridge-' . bin2hex( random_bytes( 16 ) );
			if ( ! wp_mkdir_p( $dir ) ) {
				throw new RuntimeException( 'не вдалося створити робочу папку в uploads' );
			}
			self::close_dir( $dir );

			$like   = $wpdb->esc_like( $wpdb->base_prefix ) . '%';
			$tables = $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', $like ) );
			$host   = (string) wp_parse_url( home_url(), PHP_URL_HOST );
			$job    = array(
				'format'     => self::FORMAT,
				'dir'        => $dir,
				'zip'        => $dir . '/site-' . sanitize_file_name( $host ) . '-' . gmdate( 'Ymd-His' ) . '-' . bin2hex( random_bytes( 6 ) ) . '.zip',
				'started'    => time(),
				'phase'      => 'sql',
				'tables'     => array_values( $tables ),
				'table'      => 0,
				'offset'     => 0,
				'rows'       => array(),
				'files'      => 0,
				'file_index' => 0,
				'bytes'      => 0,
				'skipped'    => array(),
				// PclZip (shipped with WordPress) when the host has no zip extension; tests force it.
				'zipper'     => apply_filters( 'agency_bridge_export_zipper', class_exists( 'ZipArchive' ) ? 'ZipArchive' : 'PclZip' ),
			);
			$head = "-- Agency bridge export (agency-export/1) of " . home_url() . ' at ' . gmdate( 'c' ) . "\n"
				. "SET NAMES utf8mb4;\nSET TIME_ZONE = '+00:00';\nSET FOREIGN_KEY_CHECKS = 0;\n\n";
			file_put_contents( $dir . '/database.sql', $head );
			self::save( $job );
			wp_schedule_single_event( time() + self::TTL + 60, 'agency_bridge_export_cleanup' );
			return self::progress( $job );
		}

		/** One step of the job within a few seconds. */
		public static function step() {
			$job = self::job();
			if ( ! $job || ! is_dir( $job['dir'] ) ) {
				throw new RuntimeException( 'експорт не запущено або його вже видалено: почніть знову' );
			}
			$until = microtime( true ) + self::budget();
			while ( 'done' !== $job['phase'] && microtime( true ) < $until ) {
				if ( 'sql' === $job['phase'] ) {
					$job = self::sql_step( $job, $until );
				} elseif ( 'list' === $job['phase'] ) {
					$job = self::list_files( $job );
				} elseif ( 'files' === $job['phase'] ) {
					$job = self::zip_step( $job, $until );
				} elseif ( 'finish' === $job['phase'] ) {
					$job = self::finish( $job );
				}
				self::save( $job );
			}
			return self::progress( $job );
		}

		/** Seconds of work per request: half the time limit, 3..20 s. */
		private static function budget() {
			$limit = (int) ini_get( 'max_execution_time' );
			if ( function_exists( 'set_time_limit' ) && false === strpos( (string) ini_get( 'disable_functions' ), 'set_time_limit' ) ) {
				@set_time_limit( 60 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- some hosts forbid it; the budget below still holds.
				$limit = 60;
			}
			$seconds = $limit > 0 ? max( 3, min( 20, $limit / 2 ) ) : 20;
			// Tests force tiny steps to check that every phase resumes where it stopped.
			return (float) apply_filters( 'agency_bridge_export_budget', $seconds );
		}

		private static function sql_step( array $job, $until ) {
			global $wpdb;
			if ( $job['table'] >= count( $job['tables'] ) ) {
				$job['phase'] = 'list';
				return $job;
			}
			$table = $job['tables'][ $job['table'] ];
			$q     = '`' . str_replace( '`', '``', $table ) . '`';
			// TIMESTAMP columns come out in the session's time zone: UTC, as mysqldump does
			// (the dump says SET TIME_ZONE = '+00:00' too). Each request is a new connection.
			$quiet = $wpdb->suppress_errors( true );
			$wpdb->query( "SET time_zone = '+00:00'" );
			$wpdb->suppress_errors( $quiet );
			$out   = fopen( $job['dir'] . '/database.sql', 'ab' );
			// The table's header once, even when a step ends before its first rows.
			if ( ! isset( $job['rows'][ $table ] ) ) {
				$create = $wpdb->get_row( "SHOW CREATE TABLE {$q}", ARRAY_N ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- a table name from SHOW TABLES, quoted.
				if ( ! $create ) {
					fclose( $out );
					throw new RuntimeException( 'не вдалося прочитати структуру таблиці ' . $table );
				}
				fwrite( $out, "DROP TABLE IF EXISTS {$q};\n" . $create[1] . ";\n\n" );
				$job['rows'][ $table ] = 0;
			}
			$order = self::primary_order( $q );
			// The job's own state is not part of the site.
			$where = $table === $wpdb->options ? " WHERE option_name NOT LIKE 'agency\\\\_bridge\\\\_%%'" : ''; // %% = a literal % in prepare().
			do {
				$rows = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM {$q}{$where}{$order} LIMIT %d, %d", $job['offset'], self::ROWS ), ARRAY_N ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name quoted above, $where fixed.
				if ( null === $rows && $wpdb->last_error ) {
					fclose( $out );
					throw new RuntimeException( 'помилка читання таблиці ' . $table . ': ' . $wpdb->last_error );
				}
				if ( ! $rows ) {
					$job['table']++;
					$job['offset'] = 0;
					fwrite( $out, "\n" );
					break;
				}
				fwrite( $out, self::inserts( $q, $rows ) );
				$job['offset']         += count( $rows );
				$job['rows'][ $table ] += count( $rows );
				if ( count( $rows ) < self::ROWS ) {
					$job['table']++;
					$job['offset'] = 0;
					fwrite( $out, "\n" );
					break;
				}
			} while ( microtime( true ) < $until );
			fclose( $out );
			return $job;
		}

		/** " ORDER BY <primary key>" so LIMIT pages are stable, or "". */
		private static function primary_order( $q ) {
			global $wpdb;
			$quiet = $wpdb->suppress_errors( true );
			$keys  = $wpdb->get_results( "SHOW KEYS FROM {$q} WHERE Key_name = 'PRIMARY'", ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- quoted table name.
			$wpdb->suppress_errors( $quiet );
			if ( ! $keys ) {
				return '';
			}
			usort(
				$keys,
				function ( $a, $b ) {
					return (int) $a['Seq_in_index'] - (int) $b['Seq_in_index'];
				}
			);
			$cols = array_map(
				function ( $k ) {
					return '`' . str_replace( '`', '``', $k['Column_name'] ) . '`';
				},
				$keys
			);
			return ' ORDER BY ' . implode( ', ', $cols );
		}

		/** INSERT statements (mysqldump escaping) of at most INSERT_MAX bytes each. */
		public static function inserts( $q, array $rows ) {
			$out  = '';
			$stmt = '';
			foreach ( $rows as $row ) {
				$vals = array();
				foreach ( $row as $v ) {
					$vals[] = null === $v ? 'NULL' : "'" . self::escape( (string) $v ) . "'";
				}
				$tuple = '(' . implode( ',', $vals ) . ')';
				if ( '' !== $stmt && strlen( $stmt ) + strlen( $tuple ) > self::INSERT_MAX ) {
					$out .= $stmt . ";\n";
					$stmt = '';
				}
				$stmt .= ( '' === $stmt ? "INSERT INTO {$q} VALUES " : ',' ) . $tuple;
			}
			if ( '' !== $stmt ) {
				$out .= $stmt . ";\n";
			}
			return $out;
		}

		/** A string literal body as mysqldump writes it (backslash escapes). */
		public static function escape( $s ) {
			return strtr(
				$s,
				array(
					'\\'   => '\\\\',
					"\0"   => '\\0',
					"\n"   => '\\n',
					"\r"   => '\\r',
					"'"    => "\\'",
					'"'    => '\\"',
					"\x1a" => '\\Z',
				)
			);
		}

		/** Every file to pack, one relative path per line in files.txt. */
		private static function list_files( array $job ) {
			$root = wp_normalize_path( untrailingslashit( ABSPATH ) );
			$list = fopen( $job['dir'] . '/files.txt', 'wb' );
			$n    = 0;
			$size = 0;
			$dirs = array( '' );
			while ( $dirs ) {
				$rel    = array_pop( $dirs );
				$handle = @opendir( '' === $rel ? $root : $root . '/' . $rel ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- unreadable folders are listed as skipped.
				if ( ! $handle ) {
					$job['skipped'][] = $rel . '/ (немає доступу)';
					continue;
				}
				while ( false !== ( $name = readdir( $handle ) ) ) { // phpcs:ignore WordPress.CodeAnalysis.AssignmentInCondition.FoundInWhileCondition
					if ( '.' === $name || '..' === $name ) {
						continue;
					}
					$path = '' === $rel ? $name : $rel . '/' . $name;
					$abs  = $root . '/' . $path;
					if ( is_link( $abs ) ) {
						$job['skipped'][] = $path . ' (посилання)';
						continue;
					}
					if ( is_dir( $abs ) ) {
						if ( preg_match( self::SKIP_DIRS, $path ) ) {
							$job['skipped'][] = $path . '/';
						} else {
							$dirs[] = $path;
						}
						continue;
					}
					if ( preg_match( self::SKIP_FILES, $path ) ) {
						$job['skipped'][] = $path;
						continue;
					}
					$bytes = (int) @filesize( $abs ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
					if ( $bytes > self::FILE_MAX ) {
						$job['skipped'][] = $path . ' (' . size_format( $bytes ) . ')';
						continue;
					}
					fwrite( $list, $path . "\n" );
					$n++;
					$size += $bytes;
				}
				closedir( $handle );
			}
			fclose( $list );
			$job['files']       = $n;
			$job['files_bytes'] = $size;
			$job['phase']       = 'files';
			return $job;
		}

		/** Adds the next files to the zip (each request reopens it: resumable). */
		private static function zip_step( array $job, $until ) {
			$root  = wp_normalize_path( untrailingslashit( ABSPATH ) );
			$list  = new SplFileObject( $job['dir'] . '/files.txt' );
			$list->seek( $job['file_index'] );
			$batch = array();
			$bytes = 0;
			// Enough for one request: ZipArchive compresses on close().
			$max = (int) apply_filters( 'agency_bridge_export_batch', 1500 );
			while ( ! $list->eof() && count( $batch ) < $max && $bytes < 64 * MB_IN_BYTES ) {
				$rel = rtrim( (string) $list->current(), "\r\n" );
				$list->next();
				if ( '' === $rel ) {
					continue;
				}
				$batch[] = $rel;
				$bytes  += (int) @filesize( $root . '/' . $rel ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			}
			$list = null;
			if ( $batch ) {
				self::add_files( $job, $root, $batch );
			}
			$job['file_index'] += count( $batch );
			if ( ! $batch || $job['file_index'] >= $job['files'] ) {
				$job['phase'] = 'finish';
			}
			return $job;
		}

		private static function add_files( array $job, $root, array $batch ) {
			if ( 'ZipArchive' === $job['zipper'] ) {
				$zip = new ZipArchive();
				if ( true !== $zip->open( $job['zip'], ZipArchive::CREATE ) ) {
					throw new RuntimeException( 'не вдалося відкрити архів для запису' );
				}
				foreach ( $batch as $rel ) {
					$abs = $root . '/' . $rel;
					if ( ! is_readable( $abs ) ) {
						continue;
					}
					$zip->addFile( $abs, 'files/' . $rel );
					if ( preg_match( '/\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|mp3|woff2?|pdf)$/i', $rel ) && method_exists( $zip, 'setCompressionName' ) ) {
						$zip->setCompressionName( 'files/' . $rel, ZipArchive::CM_STORE );
					}
				}
				if ( ! $zip->close() ) {
					throw new RuntimeException( 'не вдалося записати архів (місце на диску?)' );
				}
				return;
			}
			require_once ABSPATH . 'wp-admin/includes/class-pclzip.php';
			$zip   = new PclZip( $job['zip'] );
			$paths = array();
			foreach ( $batch as $rel ) {
				if ( is_readable( $root . '/' . $rel ) ) {
					$paths[] = $root . '/' . $rel;
				}
			}
			$ok = file_exists( $job['zip'] )
				? $zip->add( $paths, PCLZIP_OPT_REMOVE_PATH, $root, PCLZIP_OPT_ADD_PATH, 'files' )
				: $zip->create( $paths, PCLZIP_OPT_REMOVE_PATH, $root, PCLZIP_OPT_ADD_PATH, 'files' );
			if ( ! $ok ) {
				throw new RuntimeException( 'архівація не вдалась: ' . $zip->errorInfo( true ) );
			}
		}

		/** The dump and export.json go in last; the work files are removed. */
		private static function finish( array $job ) {
			global $wp_version, $wpdb;
			$sql = $job['dir'] . '/database.sql';
			file_put_contents( $sql, "SET FOREIGN_KEY_CHECKS = 1;\n", FILE_APPEND );
			$facts = array(
				'format'         => self::FORMAT,
				'created_at'     => gmdate( 'c' ),
				'siteurl'        => get_option( 'siteurl' ),
				'home'           => get_option( 'home' ),
				'wp'             => $wp_version,
				'php'            => PHP_VERSION,
				'mysql'          => $wpdb->db_version(),
				'prefix'         => $wpdb->base_prefix,
				'multisite'      => is_multisite(),
				'theme'          => get_stylesheet(),
				'template'       => get_template(),
				'active_plugins' => array_values( (array) get_option( 'active_plugins', array() ) ),
				'tables'         => $job['rows'],
				'files'          => $job['files'],
				'files_bytes'    => $job['files_bytes'] ?? 0,
				'skipped'        => array_slice( $job['skipped'], 0, 500 ),
				'zipper'         => $job['zipper'],
			);
			$meta = $job['dir'] . '/export.json';
			file_put_contents( $meta, wp_json_encode( $facts, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) );
			if ( 'ZipArchive' === $job['zipper'] ) {
				$zip = new ZipArchive();
				if ( true !== $zip->open( $job['zip'], ZipArchive::CREATE ) ) {
					throw new RuntimeException( 'не вдалося відкрити архів для запису' );
				}
				$zip->addFile( $sql, 'database.sql' );
				$zip->addFile( $meta, 'export.json' );
				if ( ! $zip->close() ) {
					throw new RuntimeException( 'не вдалося записати архів (місце на диску?)' );
				}
			} else {
				require_once ABSPATH . 'wp-admin/includes/class-pclzip.php';
				$zip = new PclZip( $job['zip'] );
				$add = file_exists( $job['zip'] ) ? 'add' : 'create';
				if ( ! $zip->$add( array( $sql, $meta ), PCLZIP_OPT_REMOVE_ALL_PATH ) ) {
					throw new RuntimeException( 'архівація не вдалась: ' . $zip->errorInfo( true ) );
				}
			}
			foreach ( array( $sql, $meta, $job['dir'] . '/files.txt' ) as $f ) {
				if ( file_exists( $f ) ) {
					unlink( $f );
				}
			}
			$job['bytes']    = (int) filesize( $job['zip'] );
			$job['phase']    = 'done';
			$job['finished'] = time();
			return $job;
		}

		/** What the page shows. */
		public static function progress( $job ) {
			if ( ! $job ) {
				return array( 'phase' => 'none' );
			}
			$tables = count( $job['tables'] );
			$pct    = 0;
			$text   = '';
			if ( 'sql' === $job['phase'] ) {
				$pct  = $tables ? (int) floor( 30 * $job['table'] / $tables ) : 30;
				$name = $job['tables'][ min( $job['table'], max( 0, $tables - 1 ) ) ] ?? '';
				$text = sprintf( 'База даних: таблиця %d з %d (%s)', min( $job['table'] + 1, $tables ), $tables, $name );
			} elseif ( 'list' === $job['phase'] ) {
				$pct  = 30;
				$text = 'Збираю список файлів…';
			} elseif ( 'files' === $job['phase'] || 'finish' === $job['phase'] ) {
				$pct  = 30 + ( $job['files'] ? (int) floor( 68 * $job['file_index'] / $job['files'] ) : 68 );
				$text = sprintf( 'Файли: %d з %d', $job['file_index'], $job['files'] );
			} elseif ( 'done' === $job['phase'] ) {
				$pct  = 100;
				$text = 'Готово: архів ' . size_format( $job['bytes'], 1 );
			}
			$zip = file_exists( $job['zip'] ) ? (int) filesize( $job['zip'] ) : 0;
			return array(
				'phase'   => $job['phase'],
				'percent' => $pct,
				'text'    => $text,
				'size'    => size_format( max( $zip, (int) $job['bytes'] ), 1 ),
				'bytes'   => max( $zip, (int) $job['bytes'] ),
				'skipped' => count( $job['skipped'] ),
				'started' => $job['started'],
			);
		}

		/** Streams the finished archive, then removes it when the whole file went out. */
		public static function download() {
			$job = self::job();
			if ( ! $job || 'done' !== $job['phase'] || ! is_file( $job['zip'] ) ) {
				throw new RuntimeException( 'архіву немає: зробіть експорт знову' );
			}
			while ( ob_get_level() ) {
				ob_end_clean();
			}
			nocache_headers();
			header( 'Content-Type: application/zip' );
			header( 'Content-Disposition: attachment; filename="' . basename( $job['zip'], '.zip' ) . '.zip"' );
			header( 'Content-Length: ' . filesize( $job['zip'] ) );
			header( 'X-Content-Type-Options: nosniff' );
			$in = fopen( $job['zip'], 'rb' );
			while ( ! feof( $in ) && ! connection_aborted() ) {
				echo fread( $in, 1048576 ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- binary file download.
				flush();
			}
			fclose( $in );
			if ( ! connection_aborted() ) {
				self::cleanup();
			}
		}

		/** Removes the job and its folder (also any stale agency-bridge folder of an old job). */
		public static function cleanup() {
			$job = self::job();
			if ( $job && ! empty( $job['dir'] ) ) {
				self::remove_tree( $job['dir'] );
			}
			delete_option( self::JOB_OPTION );
		}

		/** The 24-hour limit, also checked on admin pages (WP-Cron may not run). */
		public static function expire() {
			$job = self::job();
			if ( $job && time() - (int) $job['started'] > self::TTL ) {
				self::cleanup();
			}
		}

		private static function remove_tree( $dir ) {
			$uploads = wp_normalize_path( wp_upload_dir( null, false )['basedir'] );
			$dir     = wp_normalize_path( $dir );
			// Only our own folders in uploads are ever removed.
			if ( ! preg_match( '#/agency-bridge-[a-f0-9]{32}$#', $dir ) || 0 !== strpos( $dir, $uploads . '/' ) || ! is_dir( $dir ) ) {
				return;
			}
			$items = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::CHILD_FIRST );
			foreach ( $items as $item ) {
				$item->isDir() && ! $item->isLink() ? rmdir( $item->getPathname() ) : unlink( $item->getPathname() );
			}
			rmdir( $dir );
		}

		private static function close_dir( $dir ) {
			$files = array(
				'.htaccess'  => "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder allow,deny\nDeny from all\n</IfModule>\n",
				'index.php'  => "<?php\n// Silence is golden.\n",
				'index.html' => '',
				'web.config' => "<?xml version=\"1.0\"?>\n<configuration><system.webServer><authorization><deny users=\"*\" /></authorization></system.webServer></configuration>\n",
			);
			foreach ( $files as $name => $body ) {
				file_put_contents( $dir . '/' . $name, $body );
			}
		}
	}

endif;
