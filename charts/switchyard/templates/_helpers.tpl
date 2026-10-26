{{/* Namespace every store object lives in. */}}
{{- define "store.namespace" -}}
{{- .Values.global.namespaces.store -}}
{{- end -}}

{{/* Common labels. $component is e.g. "mariadb" or "wordpress". */}}
{{- define "switchyard.labels" -}}
app.kubernetes.io/part-of: switchyard
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/name: {{ .component }}
helm.sh/chart: {{ .root.Chart.Name }}-{{ .root.Chart.Version }}
{{- end -}}

{{/* Public storefront URL, e.g. http://shop.localtest.me */}}
{{- define "store.url" -}}
{{- ternary "https" "http" .Values.global.tls.enabled }}://{{ .Values.global.hosts.shop }}
{{- end -}}

{{/*
WordPress env, shared by the Deployment and the setup Job: the image's wp-config.php
reads these at runtime, so wp-cli in the Job needs them too.
*/}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: "mariadb.{{ include "store.namespace" . }}.svc.cluster.local:3306"
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.username | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "store.mariadbSecretName" . }}
      key: mariadb-password
# Pin the public URL so WordPress never redirects to an internal hostname.
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ include "store.url" . }}');
    define('WP_SITEURL', '{{ include "store.url" . }}');
    define('FS_METHOD', 'direct');
    {{- if .Values.wordpress.blockExternalHttp }}
    // The store needs no internet: WooCommerce is baked into the image. Blocking outbound
    // HTTP stops update checks / remote marketing specs from stalling requests on a flaky
    // network (and NetworkPolicy denies that egress anyway).
    define('WP_HTTP_BLOCK_EXTERNAL', true);
    define('AUTOMATIC_UPDATER_DISABLED', true);
    define('WP_AUTO_UPDATE_CORE', false);
    define('DISALLOW_FILE_EDIT', true);
    {{- end }}
{{- end -}}

{{/* Selector labels: must never change after first install. */}}
{{- define "switchyard.selectorLabels" -}}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/name: {{ .component }}
{{- end -}}
