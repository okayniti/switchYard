{{/* Namespace every store object lives in. */}}
{{- define "store.namespace" -}}
{{- .Values.global.namespaces.store -}}
{{- end -}}

{{/* Common labels. $component is e.g. "mariadb" or "wordpress". */}}
{{- define "store.labels" -}}
app.kubernetes.io/part-of: switchyard
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/name: {{ .component }}
helm.sh/chart: {{ .root.Chart.Name }}-{{ .root.Chart.Version }}
{{- end -}}

{{/* Selector labels: must never change after first install. */}}
{{- define "store.selectorLabels" -}}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/name: {{ .component }}
{{- end -}}
