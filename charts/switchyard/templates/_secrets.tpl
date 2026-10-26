{{/*
Return a value for key $key of Secret $name in namespace $ns: reuse the value already
in the cluster (so upgrades don't rotate passwords), otherwise generate a random one.
Usage: include "store.secretValue" (dict "root" $ "ns" $ns "name" "mariadb" "key" "x" "length" 32)
*/}}
{{- define "store.secretValue" -}}
{{- $existing := lookup "v1" "Secret" .ns .name -}}
{{- if and $existing (hasKey $existing.data .key) -}}
{{- index $existing.data .key -}}
{{- else -}}
{{- randAlphaNum (default 32 .length) | b64enc -}}
{{- end -}}
{{- end -}}

{{/* Name of the Secret holding MariaDB credentials. */}}
{{- define "store.mariadbSecretName" -}}
{{- default "mariadb" .Values.mariadb.existingSecret -}}
{{- end -}}
