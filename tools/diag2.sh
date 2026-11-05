set -e
SINCE=$(date -u -d '-14 days' +%Y-%m-%dT%H:%M:%SZ)
echo "== 시작 실패 로그 (시간, 서비스)"
gcloud logging read "severity>=WARNING AND timestamp>=\"$SINCE\" AND (textPayload:\"could not start\" OR httpRequest.status>=500)" --project=insta---dm --limit=60 --format='value(timestamp,resource.labels.service_name,httpRequest.status,httpRequest.requestUrl.slice(0,60),textPayload.slice(0,140))'
echo "== 시작 실패 직전/직후 컨테이너 로그 (오류 원인)"
gcloud logging read "resource.type=\"cloud_run_revision\" AND timestamp>=\"$SINCE\" AND (textPayload:\"Error\" OR textPayload:\"error\" OR textPayload:\"Memory\" OR textPayload:\"memory\" OR textPayload:\"exceeded\" OR textPayload:\"STARTUP\" OR textPayload:\"Container\")" --project=insta---dm --limit=40 --format='value(timestamp,resource.labels.service_name,textPayload.slice(0,200))'
echo "== 서비스 설정"
for s in igwebhook scorefile; do gcloud run services describe $s --region=asia-northeast3 --project=insta---dm --format='value(metadata.name,spec.template.spec.containers[0].resources.limits.memory,spec.template.spec.containerConcurrency,spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"],spec.template.metadata.annotations["autoscaling.knative.dev/minScale"])' || true; done
echo "== 요청 상태코드 분포 (igwebhook)"
gcloud logging read "resource.labels.service_name=\"igwebhook\" AND httpRequest.status>0 AND timestamp>=\"$SINCE\"" --project=insta---dm --limit=2000 --format='value(httpRequest.status)' | sort | uniq -c
echo "== 요청 상태코드 분포 (scorefile)"
gcloud logging read "resource.labels.service_name=\"scorefile\" AND httpRequest.status>0 AND timestamp>=\"$SINCE\"" --project=insta---dm --limit=3000 --format='value(httpRequest.status)' | sort | uniq -c
