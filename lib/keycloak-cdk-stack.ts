import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as rds from '@aws-cdk/aws-rds';
import * as ecs from '@aws-cdk/aws-ecs';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import { AuroraPostgresEngineVersion } from '@aws-cdk/aws-rds';
import { ContainerImage, LogDriver, Secret } from '@aws-cdk/aws-ecs';
import { SecurityGroup, SubnetConfiguration, SubnetType } from '@aws-cdk/aws-ec2';
import { Duration } from '@aws-cdk/core';
import { ApplicationProtocol, ListenerAction, ListenerCertificate } from '@aws-cdk/aws-elasticloadbalancingv2';

const withSubnet = (name: string, cidrMask: number, subnetType: ec2.SubnetType): SubnetConfiguration => ({
  cidrMask,
  name,
  subnetType,
});

export class KeycloakCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const paramKeycloakAdminPassword = new cdk.CfnParameter(this, 'keycloakAdminPassword', {
      type: "String",
      noEcho: true
    })

    const paramSslCertArn = new cdk.CfnParameter(this, 'sslCertArn', {
      type: "String"
    })

    const vpc = new ec2.Vpc(this, 'VPC', {
      cidr: "10.0.0.0/16",
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        withSubnet('ingress', 24, ec2.SubnetType.PUBLIC),
        withSubnet('application', 24, ec2.SubnetType.PRIVATE),
        withSubnet('data', 24, ec2.SubnetType.ISOLATED)
      ]
    });

    const dataAccessSecurityGroup = new SecurityGroup(this, 'sg', { vpc })

    const dbCluster = new rds.ServerlessCluster(this, 'AuroraKeycloakCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_10_12
      }),
      defaultDatabaseName: 'keycloak',
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.ISOLATED,
        onePerAz: true
      },
      scaling: { maxCapacity: 2, minCapacity: 2, autoPause: cdk.Duration.minutes(5) }
    });

    dbCluster.connections.allowDefaultPortFrom(dataAccessSecurityGroup)

    const taskDefinition = new ecs.FargateTaskDefinition(this, `${id}KeycloakTaskDefinition`, {
      cpu: 512,
      memoryLimitMiB: 2048,
    });

    const container = taskDefinition.addContainer(`${id}TaskDefinition`, {
      image: ContainerImage.fromRegistry("jboss/keycloak"),
      secrets: {
        DB_ADDR: Secret.fromSecretsManager(dbCluster.secret!, "host"),
        DB_USER: Secret.fromSecretsManager(dbCluster.secret!, "username"),
        DB_PORT: Secret.fromSecretsManager(dbCluster.secret!, "port"),
        DB_DATABASE: Secret.fromSecretsManager(dbCluster.secret!, "dbname"),
        DB_PASSWORD: Secret.fromSecretsManager(dbCluster.secret!, "password"),
        DB_VENDOR: Secret.fromSecretsManager(dbCluster.secret!, "engine")
      },
      environment: {
        JDBC_PARAMS: 'useSSL=false',
        KEYCLOAK_USER: 'admin',
        KEYCLOAK_PASSWORD: paramKeycloakAdminPassword.valueAsString,
        PROXY_ADDRESS_FORWARDING: 'true'
      },
      logging: LogDriver.awsLogs({ streamPrefix: 'Keycloak' })
    });

    container.addPortMappings({
      containerPort: 8080,
    });

    const cluster = new ecs.Cluster(this, `${id}KeycloakCluster`, { vpc })

    const keycloakService = new ecs.FargateService(this, `${id}KeycloakService`, {
      cluster,
      taskDefinition,
      healthCheckGracePeriod: Duration.minutes(5),
      securityGroup: dataAccessSecurityGroup,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE,
        onePerAz: true
      }
    })

    const lb = new elbv2.ApplicationLoadBalancer(this, `${id}KeycloakALB`, {
      vpc,
      internetFacing: true,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
        onePerAz: true
      }
    });

    const http = lb.addListener('HttpListiner', { port: 80 });

    http.addAction('', {
      action: ListenerAction.redirect({
        port: '443',
        protocol: ApplicationProtocol.HTTPS,
        permanent: true
      })
    });

    const https = lb.addListener('HttpsListiner', { port: 443 });

    https.addCertificates('KeycloakCert', [
      ListenerCertificate.fromArn(paramSslCertArn.valueAsString)
    ])
    https.addTargets('HttpTarget', {
      port: 8080,
      targets: [keycloakService]
    });
  }
}
