const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const ses = new AWS.SES({
    region: process.env.REGION
});
const dynamoDB = new AWS.DynamoDB.DocumentClient({
    region: process.env.REGION
});

async function downloadReleaseFromGitHub(githubRepoUrl, fileName) {
    try {
        const assetResponse = await axios.get(githubRepoUrl, {
            responseType: 'arraybuffer',
        });
        console.error("---------- filename ------------");
        console.error(fileName);
        const filePath = path.join('/tmp', `${fileName}.zip`);
        console.error("---------- filepath ------------");
        console.error(filePath);
        fs.writeFileSync(filePath, assetResponse.data);

        console.log('Asset downloaded and stored:', githubRepoUrl);

    } catch (error) {
        console.error(githubRepoUrl);
        console.error('Error downloading release from GitHub:', error);
        throw new Error('Error downloading submission file from Url');
    }
};

async function storeInGoogleCloudStorage(fileName) {
    let keyJson = Buffer.from(process.env.ACCESS_KEY, 'base64').toString();
    let key = JSON.parse(keyJson)['private_key'];
    console.error(process.env.GCP_PROJECT_ID);
    const storage = new Storage({
        projectId: process.env.GCP_PROJECT_ID,
        credentials: {
            client_email: process.env.SERVICE_EMAIL,
            private_key: key
        },
    });

    const bucketName = process.env.BUCKET_NAME;
    const filePath = `/tmp/${fileName}.zip`;
    const destinationFolder = 'assignments';

    try {
        await storage.bucket(bucketName).upload(filePath, {
            destination: `${destinationFolder}/${fileName}.zip`,
        });
        console.log('File uploaded to GCS successfully.');
    } catch (error) {
        console.error('Error uploading to GCS:', error);
        let err = new Error('Error uploading to GCS');
        err.stack = error;
        throw err;
    }
};

async function sendStatusEmail(userEmail, status, submissionDetails) {
    const successBody = `Dear ${userEmail},

    We are pleased to inform you that your recent assignment submission has been successfully uploaded to Google Cloud Storage bucket.
    
    Status: Uploaded Successfully
    Assignment ID: ${submissionDetails.assignment_id}
    Submission Date: ${submissionDetails.submission_date}
    
    Please review your submission and confirm that everything is in order.
    
    Best regards,
    Sai Veerendra Prathipati
    
    Unsubscribe: If you wish to opt-out of receiving further notifications, you can unsubscribe [here].`
    
    const failedBody = `Dear ${userEmail},

    We regret to inform you that there was an issue with the recent assignment submission. The upload to our Google Cloud Storage bucket was unsuccessful.

    Status: Upload Failed
    Assignment ID: ${submissionDetails.assignment_id}
    Submission Date: ${submissionDetails.submission_date}

    Please attempt to submit your assignment again. 
    
    Best regards,
    Sai Veerendra Prathipati
    
    Unsubscribe: If you wish to opt-out of receiving further notifications, you can unsubscribe [here].`
    
    const params = {
        Destination: { ToAddresses: [userEmail] },
        Message: {
            Body: { Text: { 
                Data: status == "success" ? successBody : failedBody
            } },
            Subject: { Data: `Assignment Upload Status` },
        },
        Source: 'alert@demo.saiveerendra-prathipati.me',
    };

    try {
        await ses.sendEmail(params).promise();
    } catch (error) {
        // throw new Error('Error sending status email');
        throw error;
    }
};

async function trackSentEmails(userEmail, status, fileName, submissionDetails) {
    const newUUID = uuidv4();
    const params = {
        TableName: process.env.DYNAMODB_TABLE,
        Item: {
            id: newUUID,
            userEmail: userEmail,
            timestamp: new Date().toISOString(),
            status: status,
            submissionURL: fileName,
            assignmentId: submissionDetails.assignment_id
        },
    };

    try {
        await dynamoDB.put(params).promise();
    } catch (error) {
        // throw new Error('Error tracking sent emails in DynamoDB');
        throw error;
    }
};

exports.handler = async (event) => {
    const snsMessage = JSON.parse(event.Records[0].Sns.Message);
    console.error(snsMessage);
    const submissionDetails = snsMessage.submissionDetails;
    const githubRepoUrl = submissionDetails.submission_url;
    const userEmail = snsMessage.userId;
    let fileName = submissionDetails.assignment_id;
    
    if(snsMessage.noOfSubmissions > 0) {
        fileName = `${submissionDetails.assignment_id}_${snsMessage.noOfSubmissions}`;
    }

    console.error(githubRepoUrl);
    console.error(userEmail);
    console.error(fileName);

    try {
        await downloadReleaseFromGitHub(githubRepoUrl, fileName);        
        await storeInGoogleCloudStorage(fileName);
        await sendStatusEmail(userEmail, 'success', submissionDetails);
        await trackSentEmails(userEmail, 'Upload successful', fileName, submissionDetails);
    } catch (error) {
        if(error.message == 'Error uploading to GCS' || 'Error downloading submission file from Url') {
            await sendStatusEmail(userEmail, 'failed', submissionDetails);
            await trackSentEmails(userEmail, 'Upload Failed', fileName, submissionDetails);
        } else {
            console.error('Error:', error);
        }    
    }
};